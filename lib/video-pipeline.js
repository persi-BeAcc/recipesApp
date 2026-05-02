// lib/video-pipeline.js
//
// Video extraction pipeline. Handles Instagram + TikTok URLs end-to-end.
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
} from './recipe-extract.js';

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function detectPlatform(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return 'unknown'; }
  if (host === 'instagram.com' || host === 'instagr.am' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  return 'web';
}

// ---------------------------------------------------------------------------
// Top-level entry point: orchestrate the full pipeline
// ---------------------------------------------------------------------------

export async function extractFromVideoUrl({ url, analysis = 'auto', onProgress = () => {} }) {
  const platform = detectPlatform(url);

  // --- Recipe blog / unknown web URL: existing extractor handles it. ---
  if (platform === 'web') {
    onProgress('Extracting from webpage');
    return extractFromUrl(url);
  }

  // --- Instagram / TikTok: resolve the reel via RapidAPI. ---
  onProgress(`Resolving ${platform} video`);
  const reel = await resolveSocialVideo(url, platform);
  // reel: { mp4Url, caption, thumbnail, author, title }

  // --- Caption-link priority: free, fast, accurate when available. ---
  const captionUrl = firstUrlIn(reel.caption || '');
  if (captionUrl) {
    onProgress('Found a recipe link in the caption — trying it first');
    try {
      const fromCaptionLink = await extractFromUrl(captionUrl);
      if (fromCaptionLink && fromCaptionLink.ingredients.length && fromCaptionLink.instructions.length) {
        return {
          ...fromCaptionLink,
          // Original reel becomes the sourceUrl so the embed renders.
          sourceUrl: url,
          // Preserve caption-blog credit too if the user wants it.
          extractedBy: `caption-link (${fromCaptionLink.extractedBy})`,
          // Image: prefer the recipe blog's hero, fall back to the reel thumbnail.
          image: fromCaptionLink.image || reel.thumbnail || '',
          // Author: keep the recipe blog author, fall back to the reel author.
          author: fromCaptionLink.author || reel.author || '',
        };
      }
    } catch (err) {
      console.warn('[caption-link] extraction failed, falling back to video:', err.message);
    }
  }

  // --- Decide on analysis mode. ---
  let mode = analysis;
  if (mode === 'auto') mode = 'audio'; // sensible default for IG/TikTok

  // --- Gemini path: single API call, no Whisper. ---
  if (mode === 'gemini') {
    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY required for gemini analysis');
    onProgress('Sending video to Gemini');
    const result = await extractWithGemini(reel.mp4Url, reel.caption);
    return {
      ...result,
      sourceUrl: url,
      image: result.image || reel.thumbnail || '',
      author: result.author || reel.author || '',
      extractedBy: 'gemini',
    };
  }

  // --- Audio path (and audio+frames). ---
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY required for audio analysis');

  onProgress('Downloading video');
  const mp4Buffer = await downloadVideo(reel.mp4Url);

  onProgress('Transcribing audio with Whisper');
  const transcript = await transcribeWithWhisper(mp4Buffer);

  // Frame analysis (only when explicitly requested AND frames were provided
  // by the client — frames are extracted in the browser and uploaded as JPEG
  // dataURLs alongside the analysis request).
  let frameNotes = '';
  if (mode === 'audio_frames') {
    onProgress('Frame analysis path: skipped (frames must come from client)');
    // Placeholder: the client uploads frames separately; the inngest worker
    // will call extractFramesWithClaude(frames) when present in event.data.
  }

  onProgress('Consolidating recipe');
  const recipe = await extractFromText({
    transcript,
    caption: reel.caption,
    frameNotes,
    sourceUrl: url,
  });

  return {
    ...recipe,
    sourceUrl: url,
    image: recipe.image || reel.thumbnail || '',
    author: recipe.author || reel.author || '',
    extractedBy: mode === 'audio_frames' ? 'whisper+frames+claude' : 'whisper+claude',
  };
}

// ---------------------------------------------------------------------------
// RapidAPI: resolve a reel URL into mp4 + caption + thumbnail + author.
//
// IMPORTANT: response shapes vary by RapidAPI provider. This function targets
// the common "all-in-one downloader" shape but you may need to adjust the
// field paths once you pick a specific API. The expected output is uniform:
//   { mp4Url, caption, thumbnail, author, title }
// ---------------------------------------------------------------------------

async function resolveSocialVideo(url, platform) {
  if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
    throw new Error('RAPIDAPI_KEY and RAPIDAPI_HOST env vars are required');
  }

  // Most all-in-one downloaders use a GET endpoint with the URL as a query param.
  // If your API uses a different path, adjust the URL below. Common shapes:
  //   https://<host>/all   ?url=...
  //   https://<host>/get   ?url=...
  //   https://<host>/dl    ?url=...
  //   https://<host>/api   ?url=...
  const endpoint = `https://${RAPIDAPI_HOST}/all?url=${encodeURIComponent(url)}`;

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST,
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`RapidAPI ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();

  // Normalize across common response shapes.
  // Shape A (most common): { url, title, thumbnail, medias: [{ url, type: 'video' }, ...] }
  // Shape B: { video_url, caption, thumbnail, author }
  // Shape C: { data: { hd_play, music, author, title, ... } }
  const mp4Url =
    pickFirst(data, ['video_url', 'hd_play', 'play', 'url']) ||
    pickFromArray(data.medias, 'video') ||
    pickFromArray(data.data?.medias, 'video') ||
    (data.data && pickFirst(data.data, ['hd_play', 'play', 'video_url'])) ||
    null;

  const caption =
    pickFirst(data, ['caption', 'description', 'desc', 'title']) ||
    pickFirst(data.data || {}, ['title', 'desc', 'description']) ||
    '';

  const thumbnail =
    pickFirst(data, ['thumbnail', 'thumb', 'cover', 'image']) ||
    pickFirst(data.data || {}, ['cover', 'thumb', 'thumbnail']) ||
    '';

  const author =
    pickFirst(data, ['author', 'author_name', 'username']) ||
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
  const res = await fetch(mp4Url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    },
  });
  if (!res.ok) throw new Error(`mp4 download (${res.status})`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
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
    throw new Error(`Whisper API ${res.status}: ${t.slice(0, 200)}`);
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
    throw new Error(`Claude vision ${res.status}: ${t.slice(0, 200)}`);
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
    throw new Error(`Gemini upload init ${startRes.status}: ${t.slice(0, 200)}`);
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
    throw new Error(`Gemini upload finalize ${uploadRes.status}: ${t.slice(0, 200)}`);
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
    throw new Error(`Gemini generate ${genRes.status}: ${t.slice(0, 200)}`);
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
