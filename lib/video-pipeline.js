// lib/video-pipeline.js
//
// Video extraction pipeline. Handles Instagram + TikTok + YouTube URLs end-to-end.
//
// Pipeline:
//   1. Detect platform (instagram / tiktok / web)
//   2. For IG/TikTok: resolve mp4 + caption + thumbnail via RapidAPI
//   3. CAPTION-LINK PRIORITY: if the caption contains a URL, try to extract
//      a recipe from THAT URL first — fast, free, more reliable than video.
//   4. Otherwise, run the chosen analysis on the video:
//        audio        → Whisper (mp4 → transcript) → Claude consolidate
//        audio_frames → Whisper + browser-extracted frames → Claude vision → consolidate
//        gemini       → Gemini File API → single video understanding call
//   5. Always fold the caption into the consolidation prompt for extra context.
//
// All paths return the same recipe shape (see lib/recipe-extract.js).

import {
  extractFromUrl,
  extractFromText,
  cleanString,
  firstUrlIn,
  humanizeApiError,
} from './recipe-extract.js';

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;

// ---------------------------------------------------------------------------
// Caption heuristic: does this look like a full recipe written out in text?
// We check for the structural words that recipe creators use — Ingredients
// + (Method/Instructions/Steps/Directions). This isn't perfect but catches
// the vast majority of well-written caption recipes.
// ---------------------------------------------------------------------------

// Aggressive: try the caption-only path for any caption with substantial
// text (≥80 chars). If Claude can't actually find a recipe in it, the caller
// validates `ingredients.length && instructions.length` and falls through to
// the video pipeline. This trades a few cents of Claude calls on teaser
// captions for never missing a recipe that's written in less-structured form
// (e.g. no "Ingredients:" header, just a numbered list, or paragraph form).
function looksLikeFullRecipe(caption) {
  if (!caption) return false;
  // Strip hashtags + URLs so a hashtag-only caption doesn't pass the length test
  const meaningful = caption.replace(/#\S+/g, '').replace(/https?:\/\/\S+/g, '').trim();
  return meaningful.length >= 80;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function detectPlatform(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return 'unknown'; }
  if (host === 'instagram.com' || host === 'instagr.am' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com'
      || host === 'music.youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  return 'web';
}

// ---------------------------------------------------------------------------
// Top-level entry point: orchestrate the full pipeline
// ---------------------------------------------------------------------------

// Pipeline output shape: { recipe, mp4Buffer? }
//   - recipe is always present
//   - mp4Buffer is set when we successfully downloaded the video (IG/TikTok),
//     so the caller can archive it to Dropbox for inline playback later.
//
// `prefetchedReel` is an optional opt-in for the Inngest worker, which calls
// resolveSocialVideo() in its own step.run('resolve') so RapidAPI failures
// can retry independently of the (more expensive) Whisper/Claude work.
export async function extractFromVideoUrl({ url, analysis = 'auto', onProgress = () => {}, prefetchedReel = null }) {
  const platform = detectPlatform(url);

  // --- Recipe blog / unknown web URL: existing extractor handles it. ---
  if (platform === 'web') {
    onProgress('Extracting from webpage');
    const recipe = await extractFromUrl(url);
    return { recipe, mp4Buffer: null };
  }

  // --- Instagram / TikTok: resolve the reel via RapidAPI (unless caller already did). ---
  let reel = prefetchedReel;
  if (!reel) {
    onProgress(`Resolving ${platform} video`);
    reel = await resolveSocialVideo(url, platform);
  }
  // reel: { mp4Url, caption, thumbnail, author, title }

  // Start the mp4 download in PARALLEL with all extraction paths so that:
  //   - whichever path wins, we'll have the mp4 ready for archive
  //   - caption-only / caption-link paths don't pay the download in serial —
  //     it overlaps with their (cheap) Claude calls
  // Failure to download is tolerated: archive is best-effort, not required.
  const mp4DownloadP = downloadVideo(reel.mp4Url).catch(err => {
    console.warn('[archive] mp4 download failed:', err.message);
    return null;
  });

  // --- Caption-link priority: free, fast, accurate when available. ---
  const captionUrl = firstUrlIn(reel.caption || '');
  if (captionUrl) {
    onProgress('Found a recipe link in the caption — trying it first');
    try {
      const fromCaptionLink = await extractFromUrl(captionUrl);
      if (fromCaptionLink && fromCaptionLink.ingredients.length && fromCaptionLink.instructions.length) {
        const mp4Buffer = await mp4DownloadP;
        return {
          recipe: {
            ...fromCaptionLink,
            sourceUrl: url,
            extractedBy: `caption-link (${fromCaptionLink.extractedBy})`,
            image: fromCaptionLink.image || reel.thumbnail || '',
            author: fromCaptionLink.author || reel.author || '',
          },
          mp4Buffer,
        };
      }
    } catch (err) {
      console.warn('[caption-link] extraction failed, falling back to video:', err.message);
    }
  }

  // --- Caption-only fast path: skip Whisper when the caption itself has the recipe. ---
  // Try this first for ANY substantial caption — if Claude can't find a recipe
  // we transparently fall through to Whisper.
  if (looksLikeFullRecipe(reel.caption)) {
    onProgress('Trying the caption first');
    try {
      const fromCaption = await extractFromText({
        caption: reel.caption,
        sourceUrl: url,
      });
      if (fromCaption && fromCaption.ingredients.length && fromCaption.instructions.length) {
        const mp4Buffer = await mp4DownloadP;
        return {
          recipe: {
            ...fromCaption,
            sourceUrl: url,
            image: fromCaption.image || reel.thumbnail || '',
            author: fromCaption.author || reel.author || '',
            extractedBy: 'caption-only',
          },
          mp4Buffer,
        };
      }
    } catch (err) {
      console.warn('[caption-only] extraction failed, falling back to video:', err.message);
    }
  }

  // --- Decide on analysis mode. ---
  // Default ('auto'): prefer Gemini Flash if a key is configured — it's
  // cheaper AND faster than Whisper+Claude for video, and handles silent
  // demo reels where Whisper finds nothing. Fall back to audio if no key.
  let mode = analysis;
  if (mode === 'auto') mode = GEMINI_KEY ? 'gemini' : 'audio';

  // --- Gemini path: single API call, no Whisper. ---
  if (mode === 'gemini') {
    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY required for gemini analysis');
    onProgress('Sending video to Gemini');
    const result = await extractWithGemini(reel.mp4Url, reel.caption);
    const mp4Buffer = await mp4DownloadP;
    return {
      recipe: {
        ...result,
        sourceUrl: url,
        image: result.image || reel.thumbnail || '',
        author: result.author || reel.author || '',
        extractedBy: 'gemini',
      },
      mp4Buffer,
    };
  }

  // --- Audio path (and audio+frames). ---
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY required for audio analysis');

  onProgress('Transcribing audio with Whisper');
  const mp4Buffer = await mp4DownloadP;
  if (!mp4Buffer) throw new Error('mp4 download failed — cannot transcribe');
  const transcript = await transcribeWithWhisper(mp4Buffer);

  let frameNotes = '';
  if (mode === 'audio_frames') {
    onProgress('Frame analysis path: skipped (frames must come from client)');
  }

  onProgress('Consolidating recipe');
  const recipe = await extractFromText({
    transcript,
    caption: reel.caption,
    frameNotes,
    sourceUrl: url,
  });

  // If audio + caption together produced nothing usable (silent demo reels
  // with no narration and no caption), automatically try the Gemini full-
  // video path as a last resort. Gemini "watches" the video and can read
  // visual ingredients / on-screen text when there's no audio narration.
  const isEmpty = (!recipe.ingredients || !recipe.ingredients.length) &&
                  (!recipe.instructions || !recipe.instructions.length);
  if (isEmpty) {
    if (GEMINI_KEY) {
      onProgress('Audio was silent — analyzing the video itself with Gemini');
      try {
        const fromGemini = await extractWithGemini(reel.mp4Url, reel.caption);
        if (fromGemini && fromGemini.ingredients.length && fromGemini.instructions.length) {
          return {
            recipe: {
              ...fromGemini,
              sourceUrl: url,
              image: fromGemini.image || reel.thumbnail || '',
              author: fromGemini.author || reel.author || '',
              extractedBy: 'gemini-fallback',
            },
            mp4Buffer,
          };
        }
      } catch (err) {
        console.warn('[gemini-fallback] failed:', err.message);
      }
    }
    // Either no Gemini key, or Gemini also came up empty. Tell the user.
    throw new Error("Couldn't extract a recipe from this video. There's no caption/description, no spoken narration, and the visual analysis didn't recognize a recipe. Try opening the video directly to read it, or pick a different one.");
  }

  return {
    recipe: {
      ...recipe,
      sourceUrl: url,
      image: recipe.image || reel.thumbnail || '',
      author: recipe.author || reel.author || '',
      // Always emit 'whisper+claude' here. The Inngest worker is the only
      // place that handles the audio_frames branch; it appends '+frames' to
      // produce the canonical 'whisper+claude+frames' id used by extractedByLabel.
      extractedBy: 'whisper+claude',
    },
    mp4Buffer,
  };
}

// ---------------------------------------------------------------------------
// RapidAPI: resolve a reel URL into mp4 + caption + thumbnail + author.
//
// Wired against "Auto Download All In One (Big)":
//   POST https://auto-download-all-in-one-big.p.rapidapi.com/v1/social/autolink
//   body: {"url": "..."}
//   handles Instagram + TikTok + YouTube + others, auto-detects platform.
//
// The response field-picking below is intentionally generous so it will also
// work with several similar all-in-one providers (different field names but
// same shape). We always normalize to:
//   { mp4Url, caption, thumbnail, author, title }
// ---------------------------------------------------------------------------

export async function resolveSocialVideo(url, platform) {
  if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
    throw new Error('RAPIDAPI_KEY and RAPIDAPI_HOST env vars are required');
  }

  // Auto Download All In One: POST /v1/social/autolink with {url} in body.
  const endpoint = `https://${RAPIDAPI_HOST}/v1/social/autolink`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST,
    },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(humanizeApiError('RapidAPI', res.status, t));
  }
  const data = await res.json();

  // Normalize across common response shapes.
  // Auto Download All In One (Big) shape:
  //   { url: "<source URL>", title: "<caption>", thumbnail, author,
  //     medias: [{ type: 'video', url: '...mp4', ... }, { type: 'audio', ... }] }
  // Other providers' shapes also handled.
  //
  // CRITICAL: do NOT pick top-level `url` — for AutoDLBig that's the SOURCE
  // Instagram URL, not the mp4. Always prefer the `medias` array first.
  const mp4Url =
    pickFromArray(data.medias, 'video') ||
    pickFromArray(data.data?.medias, 'video') ||
    pickFirst(data, ['video_url', 'hd_play', 'play', 'video', 'mp4']) ||
    (data.data && pickFirst(data.data, ['hd_play', 'play', 'video_url'])) ||
    null;

  const caption =
    pickFirst(data, ['caption', 'description', 'desc', 'title']) ||
    pickFirst(data.data || {}, ['title', 'desc', 'description', 'caption']) ||
    '';

  const thumbnail =
    pickFirst(data, ['thumbnail', 'thumb', 'cover', 'image']) ||
    pickFirst(data.data || {}, ['cover', 'thumb', 'thumbnail']) ||
    '';

  const author =
    pickFirst(data, ['author', 'author_name', 'username']) ||
    (data.owner && pickFirst(data.owner, ['full_name', 'username'])) ||
    pickFirst(data.data?.author || {}, ['nickname', 'unique_id', 'name']) ||
    '';

  if (!mp4Url) {
    throw new Error(`Could not find mp4 URL in RapidAPI response. Adjust resolveSocialVideo() to match your provider's shape. Sample keys: ${Object.keys(data).slice(0, 10).join(', ')}`);
  }

  return {
    mp4Url:    String(mp4Url),
    caption:   cleanString(caption),
    thumbnail: typeof thumbnail === 'string' ? thumbnail : '',
    author:    typeof author === 'string' ? author : '',
    title:     cleanString(data.title || (data.data && data.data.title) || ''),
  };
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === 'string') return obj[k];
  }
  return null;
}

function pickFromArray(arr, type) {
  if (!Array.isArray(arr)) return null;
  const m = arr.find(x => x && (x.type === type || (type === 'video' && x.url && /\.mp4/i.test(x.url))));
  return m ? (m.url || m.src || null) : null;
}

// ---------------------------------------------------------------------------
// Download the mp4 into memory. Reels are usually 5-30MB.
// ---------------------------------------------------------------------------

async function downloadVideo(mp4Url) {
  console.log('[downloadVideo] fetching:', mp4Url.slice(0, 200));
  const res = await fetch(mp4Url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    },
  });
  if (!res.ok) throw new Error(`mp4 download (${res.status})`);
  const contentType = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  // Sniff first 16 bytes — mp4 starts with `....ftyp` (offsets 4-7 = 'ftyp')
  const head = buf.slice(0, 32).toString('hex');
  const looksLikeMp4 = buf.slice(4, 8).toString('utf-8') === 'ftyp';
  console.log(`[downloadVideo] got ${buf.length} bytes, content-type="${contentType}", first-bytes-hex=${head.slice(0, 32)}, looks-like-mp4=${looksLikeMp4}`);
  if (!looksLikeMp4 && buf.length < 5_000_000) {
    // Likely an HTML error page or some other small non-video payload.
    const sample = buf.slice(0, 200).toString('utf-8');
    throw new Error(`Downloaded payload is not an mp4 (content-type=${contentType}, ${buf.length}B). First bytes: ${sample}`);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Whisper: mp4 buffer → transcript text.
// Whisper accepts video files directly; it pulls audio internally.
// 25MB upload limit; we'll fail loudly if a reel exceeds that.
// ---------------------------------------------------------------------------

async function transcribeWithWhisper(mp4Buffer) {
  if (mp4Buffer.length > 25 * 1024 * 1024) {
    throw new Error(`Video is ${(mp4Buffer.length / 1024 / 1024).toFixed(1)}MB, exceeds Whisper's 25MB limit`);
  }
  const form = new FormData();
  form.append('file', new Blob([mp4Buffer], { type: 'video/mp4' }), 'reel.mp4');
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(humanizeApiError('OpenAI', res.status, t));
  }
  const data = await res.json();
  return data.text || '';
}

// ---------------------------------------------------------------------------
// Claude vision: read keyframes (sent by the browser as JPEG dataURLs)
// and extract any visible text — measurements, ingredient lists, etc.
// ---------------------------------------------------------------------------

export async function extractFramesWithClaude(frameDataUrls) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY required');
  if (!Array.isArray(frameDataUrls) || !frameDataUrls.length) return '';

  const images = frameDataUrls.slice(0, 6).map(dataUrl => {
    const m = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (!m) return null;
    return {
      type: 'image',
      source: { type: 'base64', media_type: m[1], data: m[2] },
    };
  }).filter(Boolean);

  if (!images.length) return '';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...images,
          {
            type: 'text',
            text: 'Read every visible text overlay across these recipe video frames — measurements, ingredient names, temperatures, step instructions. Return a plain-text list, one item per line, with no commentary. If a frame has no useful text, skip it. Do not invent details.',
          },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(humanizeApiError('Anthropic', res.status, t));
  }
  const body = await res.json();
  return (body.content || []).map(c => c.text || '').join('\n').trim();
}

// ---------------------------------------------------------------------------
// Gemini path: upload mp4 to Gemini File API, then prompt for structured JSON.
// Single API exchange handles audio + visual together.
// ---------------------------------------------------------------------------

async function extractWithGemini(mp4Url, caption) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY required');

  // 1. Download the mp4 (Gemini File API doesn't fetch external URLs).
  const buf = await downloadVideo(mp4Url);

  // 2. Upload to Gemini File API (resumable upload protocol).
  const startRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'reel.mp4' } }),
  });
  if (!startRes.ok) {
    const t = await startRes.text();
    throw new Error(humanizeApiError('Gemini', startRes.status, t));
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini upload URL missing from response');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buf.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buf,
  });
  if (!uploadRes.ok) {
    const t = await uploadRes.text();
    throw new Error(humanizeApiError('Gemini', uploadRes.status, t));
  }
  const fileData = await uploadRes.json();
  const fileUri = fileData.file?.uri;
  if (!fileUri) throw new Error('Gemini did not return a file URI');

  // Wait for the file to become ACTIVE (Gemini takes a moment to process video).
  for (let i = 0; i < 20; i++) {
    const statusRes = await fetch(`${fileData.file.name ? `https://generativelanguage.googleapis.com/v1beta/${fileData.file.name}` : fileUri}?key=${GEMINI_KEY}`);
    if (statusRes.ok) {
      const status = await statusRes.json();
      if (status.state === 'ACTIVE') break;
      if (status.state === 'FAILED') throw new Error('Gemini file processing failed');
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // 3. Generate structured recipe JSON.
  const prompt = `Watch this recipe video carefully and extract the recipe.

${caption ? `For context, here is the caption posted with the video:\n${caption}\n\n` : ''}Respond with ONLY a JSON object (no prose, no markdown fences) in exactly this shape:

{
  "title": string,
  "description": string,
  "ingredients": [string, ...],
  "instructions": [string, ...],
  "prepTime": string,
  "cookTime": string,
  "totalTime": string,
  "servings": string,
  "image": string,
  "author": string
}

Capture ingredient measurements precisely. Each step must be one coherent action. Use "" or [] for missing fields.`;

  const genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
          { text: prompt },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  if (!genRes.ok) {
    const t = await genRes.text();
    throw new Error(humanizeApiError('Gemini', genRes.status, t));
  }
  const genData = await genRes.json();
  const text = genData.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini returned no JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    title:        cleanString(parsed.title),
    description:  cleanString(parsed.description),
    ingredients:  Array.isArray(parsed.ingredients)  ? parsed.ingredients.map(cleanString).filter(Boolean)  : [],
    instructions: Array.isArray(parsed.instructions) ? parsed.instructions.map(cleanString).filter(Boolean) : [],
    prepTime:     cleanString(parsed.prepTime),
    cookTime:     cleanString(parsed.cookTime),
    totalTime:    cleanString(parsed.totalTime),
    servings:     cleanString(parsed.servings),
    image:        cleanString(parsed.image),
    author:       cleanString(parsed.author),
  };
}
