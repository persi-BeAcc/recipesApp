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
  let html;
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) throw new Error(`source returned ${r.status}`);
    html = await r.text();
  } catch (e) {
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
    throw new Error(`Claude API ${r.status}: ${err.slice(0, 200)}`);
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
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
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
