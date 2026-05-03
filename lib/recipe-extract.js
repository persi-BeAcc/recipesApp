// lib/recipe-extract.js
//
// Shared recipe extraction helpers — used by both the URL extractor in
// api/recipes.js and the video pipeline in lib/video-pipeline.js.
//
// Two main extractors:
//   - extractFromUrl(url): fetch a webpage, try JSON-LD first, fall back to Claude.
//   - extractFromText({ transcript, caption, frameNotes, source }): take any
//     combination of text inputs and ask Claude to consolidate into a single
//     recipe JSON. Used by the video pipeline.
//
// All extractors return the same shape:
//   { title, description, ingredients[], instructions[],
//     prepTime, cookTime, totalTime, servings, image, author,
//     sourceUrl, extractedBy }

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Public: extract from a webpage URL
// ---------------------------------------------------------------------------

export async function extractFromUrl(url) {
  // Reject anything pointing at private/loopback/metadata IPs (SSRF guard).
  if (!isPublicHttpUrl(url)) {
    throw new Error('URL is not a public http(s) address');
  }
  let html;
  try {
    const r = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, 15000);
    if (!r.ok) throw new Error(`source returned ${r.status}`);
    // Cap at 5MB to defend against pathological responses.
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 5_000_000) {
        try { reader.cancel(); } catch {}
        throw new Error('source response exceeded 5MB');
      }
      chunks.push(value);
    }
    html = new TextDecoder('utf-8').decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Source took too long to respond (timed out)');
    throw new Error(`could not fetch URL: ${e.message}`);
  }

  // 1. JSON-LD pass — fast, accurate, free
  const fromLd = extractFromJsonLd(html);
  if (fromLd && fromLd.ingredients.length && fromLd.instructions.length) {
    return { ...fromLd, sourceUrl: url, extractedBy: 'json-ld' };
  }

  // 2. Claude fallback
  if (!ANTHROPIC_KEY) {
    if (fromLd) return { ...fromLd, sourceUrl: url, extractedBy: 'json-ld-partial' };
    throw new Error('No machine-readable recipe data on this page, and no ANTHROPIC_API_KEY set.');
  }
  const fromClaude = await extractFromText({
    pageText: htmlToText(html).slice(0, 60000),
    sourceUrl: url,
  });
  return { ...fromClaude, sourceUrl: url, extractedBy: 'claude' };
}

// ---------------------------------------------------------------------------
// Public: consolidate any combination of text sources into one recipe.
// Used by the video pipeline (caption + transcript + frame notes).
// ---------------------------------------------------------------------------

export async function extractFromText({ pageText = '', transcript = '', caption = '', frameNotes = '', sourceUrl = '' }) {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for Claude extraction');
  }

  const sections = [];
  if (pageText)   sections.push(`PAGE TEXT:\n${pageText}`);
  if (caption)    sections.push(`INSTAGRAM/TIKTOK CAPTION:\n${caption}`);
  if (transcript) sections.push(`AUDIO TRANSCRIPT:\n${transcript}`);
  if (frameNotes) sections.push(`VISIBLE TEXT FROM VIDEO FRAMES:\n${frameNotes}`);

  if (!sections.length) {
    throw new Error('extractFromText called with no content sources');
  }

  const prompt = `You are extracting a single recipe from one or more sources about the same dish.

Respond with ONLY a JSON object (no prose, no markdown fences) in exactly this shape:

{
  "title": string,
  "description": string,
  "ingredients": [string, ...],   // each string is ONE ingredient line, including the measurement (e.g. "2 tbsp olive oil")
  "instructions": [string, ...],  // each string is ONE discrete step, in order
  "prepTime": string,             // e.g. "15m", "1h 30m", or "" if not given
  "cookTime": string,
  "totalTime": string,
  "servings": string,
  "image": string,
  "author": string
}

Rules:
- Strip life stories, ads, and SEO filler. Capture only the recipe itself.
- Keep ingredient measurements EXACTLY as written.
- Each step in "instructions" must be a single coherent action.
- If a field isn't present, use "" or [].
- If sources disagree (e.g. caption says "1 cup" but transcript says "two cups"),
  prefer measurements from the WRITTEN sources (caption, page text) over the audio transcript.
- Combine information across all sources — the caption may have a measurement that
  the audio narrator skipped, or the audio may have a step the caption didn't list.

${sourceUrl ? `SOURCE URL: ${sourceUrl}\n` : ''}
${sections.join('\n\n')}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(humanizeApiError('Anthropic', r.status, err));
  }
  const body = await r.json();
  const content = (body.content || []).map(c => c.text || '').join('').trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');
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

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

export function extractFromJsonLd(html) {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const raw = m[1].trim();
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const recipe = findRecipe(data);
    if (recipe) return normalizeRecipe(recipe);
  }
  return null;
}

function findRecipe(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findRecipe(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof data !== 'object') return null;
  const t = data['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return data;
  if (data['@graph']) return findRecipe(data['@graph']);
  return null;
}

function normalizeRecipe(r) {
  return {
    title:        cleanString(r.name),
    description:  cleanString(r.description),
    ingredients:  Array.isArray(r.recipeIngredient)
                    ? r.recipeIngredient.map(cleanString).filter(Boolean)
                    : [],
    instructions: normalizeInstructions(r.recipeInstructions),
    prepTime:     formatDuration(r.prepTime),
    cookTime:     formatDuration(r.cookTime),
    totalTime:    formatDuration(r.totalTime),
    servings:     normalizeYield(r.recipeYield),
    image:        normalizeImage(r.image),
    author:       extractAuthor(r.author),
  };
}

function normalizeInstructions(ins) {
  if (!ins) return [];
  if (typeof ins === 'string') return splitInstructions(ins);
  if (!Array.isArray(ins)) return [];
  const out = [];
  for (const step of ins) {
    if (typeof step === 'string') {
      out.push(cleanString(step));
    } else if (step && typeof step === 'object') {
      if (step['@type'] === 'HowToSection' && Array.isArray(step.itemListElement)) {
        if (step.name) out.push(`— ${cleanString(step.name)} —`);
        for (const sub of step.itemListElement) {
          if (typeof sub === 'string') out.push(cleanString(sub));
          else if (sub && sub.text) out.push(cleanString(sub.text));
        }
      } else if (step.text) {
        out.push(cleanString(step.text));
      } else if (step.name) {
        out.push(cleanString(step.name));
      }
    }
  }
  return out.filter(Boolean);
}

function splitInstructions(text) {
  return text
    .split(/\n+|(?<=\.)\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeImage(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return normalizeImage(img[0]);
  if (img.url) return typeof img.url === 'string' ? img.url : '';
  return '';
}

function extractAuthor(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.map(extractAuthor).filter(Boolean).join(', ');
  if (a.name) return cleanString(a.name);
  return '';
}

function normalizeYield(y) {
  if (!y) return '';
  if (Array.isArray(y)) return cleanString(y[0]);
  return cleanString(y);
}

export function cleanString(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Numeric character references: handles both &#39; and &#039; (zero-padded)
    .replace(/&#0*([0-9]+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return n > 0 && n < 0x10000 ? String.fromCharCode(n) : '';
    })
    // Hex character references: &#x27; (apostrophe) etc.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      const n = parseInt(code, 16);
      return n > 0 && n < 0x10000 ? String.fromCharCode(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatDuration(d) {
  if (!d || typeof d !== 'string') return '';
  const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return d;
  const [, h, mi] = m;
  const parts = [];
  if (h)  parts.push(`${h}h`);
  if (mi) parts.push(`${mi}m`);
  return parts.join(' ');
}

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Find the first http(s) URL in arbitrary text. Used to look for recipe-blog
// links inside Instagram captions.
export function firstUrlIn(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"]+/);
  return m ? m[0] : null;
}

// fetch() with a hard timeout. If the source server hangs, we don't tie up
// the Vercel function for 60s — bail at 15s by default.
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Reject URLs that point at private/loopback IPs to avoid SSRF surface from
// user-supplied URLs (recipe-blog imports, caption-link extraction, RapidAPI
// download URLs). Returns true when the URL is safe to fetch.
export function isPublicHttpUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // hostname for IPv6 includes brackets — strip them for the comparison.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    // Reject loopback + AWS/GCP/Azure metadata + RFC1918 private + link-local
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '169.254.169.254' ||  // AWS/GCP metadata
      host === 'metadata.google.internal' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^fc[0-9a-f]{2}:/i.test(host) ||
      /^fd[0-9a-f]{2}:/i.test(host) ||
      /^fe80:/i.test(host) ||
      host === '::1' ||
      host === '0:0:0:0:0:0:0:1'
    ) return false;
    return true;
  } catch {
    return false;
  }
}

// Map an HTTP error response to a user-friendly message identifying which
// service ran out of credits / hit a rate limit / has a bad key. The
// pipeline throws these and the Inngest worker propagates them to the
// import sheet's error screen, so the user knows exactly what to fix.
export function humanizeApiError(service, status, bodyText) {
  const body = String(bodyText || '').toLowerCase();
  // Out of credits — providers each phrase it differently.
  const outOfCredit = (
    status === 402 ||
    /credit[\s_]+balance.{0,20}too[\s_]+low/.test(body) ||
    /insufficient[\s_]*(quota|credit|balance|funds)/.test(body) ||
    /out[\s_]+of[\s_]+credit/.test(body) ||
    /quota[\s_]+exhausted/.test(body) ||
    /payment[\s_]+required/.test(body) ||
    /\bbilling\b/.test(body)
  );
  if (outOfCredit) {
    const links = {
      OpenAI:    'https://platform.openai.com/settings/organization/billing',
      Anthropic: 'https://console.anthropic.com/settings/billing',
      Gemini:    'https://aistudio.google.com/apikey',
      RapidAPI:  'https://rapidapi.com/developer/billing',
    };
    const link = links[service] || '';
    return `${service} is out of credits. Top up${link ? ' at ' + link : ''} to continue.`;
  }
  if (status === 401 || status === 403) {
    return `${service} rejected our credentials. Check the API key in Vercel env vars.`;
  }
  if (status === 429) {
    return `${service} is rate-limiting us. Try again in a minute.`;
  }
  if (status === 413) {
    return `${service} rejected the file: too large.`;
  }
  // Fall through with the raw body trimmed
  return `${service} error (${status}): ${String(bodyText || '').slice(0, 160)}`;
}
