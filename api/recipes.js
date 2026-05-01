// api/recipes.js
//
// Single Vercel serverless function that:
//   1. Gates every request behind a shared APP_PASSCODE header
//   2. Reads/writes a per-recipe JSON store inside the Dropbox "App folder"
//      (Apps/Recipes/) using a long-lived refresh token owned by Bea
//   3. Extracts new recipes from a URL — JSON-LD Recipe schema first
//      (laser-focused, free), Claude API fallback when the page has none
//
// Routes (all under /api/recipes):
//   GET    /api/recipes              → list all recipes (full bodies)
//   GET    /api/recipes?id=xyz       → fetch one recipe
//   POST   /api/recipes?extract=1    → body {url} → returns parsed recipe (no save)
//   PUT    /api/recipes?id=xyz       → body recipe → upsert
//   DELETE /api/recipes?id=xyz       → delete

import { Dropbox } from 'dropbox';

const PASSCODE        = process.env.APP_PASSCODE;
const APP_KEY         = process.env.DROPBOX_APP_KEY;
const APP_SECRET      = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN   = process.env.DROPBOX_REFRESH_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Passcode gate — without this, the Vercel URL is world-readable.
  const pass = req.headers['x-app-passcode'];
  if (!PASSCODE || pass !== PASSCODE) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    return json(res, 500, { error: 'server missing Dropbox credentials' });
  }

  const dbx = new Dropbox({
    clientId: APP_KEY,
    clientSecret: APP_SECRET,
    refreshToken: REFRESH_TOKEN,
    fetch,
  });

  const { method, query } = req;
  const id = (query.id || '').toString().trim();

  try {
    // -------- extract --------
    if (method === 'POST' && (query.extract === '1' || query.extract === 'true')) {
      const body = await readJsonBody(req);
      const url = (body && body.url || '').toString().trim();
      if (!url) return json(res, 400, { error: 'missing url' });
      const recipe = await extractRecipe(url);
      return json(res, 200, recipe);
    }

    // -------- list --------
    if (method === 'GET' && !id) {
      const list = await dbx.filesListFolder({ path: '' });
      const files = list.result.entries.filter(
        e => e['.tag'] === 'file' && e.name.endsWith('.json') && e.name.startsWith('recipe-')
      );
      const recipes = await Promise.all(
        files.map(async f => {
          try {
            const dl = await dbx.filesDownload({ path: f.path_lower });
            const text = await blobToText(dl.result);
            return JSON.parse(text);
          } catch {
            return null;
          }
        })
      );
      return json(res, 200, { recipes: recipes.filter(Boolean) });
    }

    // -------- read one --------
    if (method === 'GET' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      const dl = await dbx.filesDownload({ path: `/recipe-${id}.json` });
      const text = await blobToText(dl.result);
      return json(res, 200, JSON.parse(text));
    }

    // -------- upsert --------
    if (method === 'PUT' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return json(res, 400, { error: 'missing recipe body' });
      }
      const now = new Date().toISOString();
      const recipe = {
        ...body,
        id,
        updatedAt: now,
        createdAt: body.createdAt || now,
      };
      await dbx.filesUpload({
        path: `/recipe-${id}.json`,
        contents: JSON.stringify(recipe, null, 2),
        mode: { '.tag': 'overwrite' },
        mute: true,
      });
      return json(res, 200, recipe);
    }

    // -------- delete --------
    if (method === 'DELETE' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      try {
        await dbx.filesDeleteV2({ path: `/recipe-${id}.json` });
      } catch (e) {
        // tolerate "not found" so deletes are idempotent
        if (!String(e).includes('not_found')) throw e;
      }
      return json(res, 200, { ok: true, id });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('[recipes api]', e);
    const msg = e && (e.message || e.error_summary) ? (e.message || e.error_summary) : 'internal error';
    return json(res, 500, { error: String(msg).slice(0, 500) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

function isSafeId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

async function readJsonBody(req) {
  // Vercel parses application/json automatically, but be defensive.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // stream fallback
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return null; }
}

async function blobToText(result) {
  // The Dropbox SDK puts the file payload on different fields depending on
  // the runtime. On Node it's `fileBinary` (Buffer); on browsers it's
  // `fileBlob`. Handle both so this code stays portable.
  const bin = result.fileBinary;
  if (bin) {
    if (Buffer.isBuffer(bin)) return bin.toString('utf-8');
    if (bin instanceof Uint8Array) return Buffer.from(bin).toString('utf-8');
  }
  const blob = result.fileBlob;
  if (blob && typeof blob.text === 'function') return await blob.text();
  return String(bin || blob || '');
}

// ---------------------------------------------------------------------------
// Recipe extraction
// ---------------------------------------------------------------------------

async function extractRecipe(url) {
  let html;
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        // Some sites block obvious bots. Pretend to be a normal browser.
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

  // 2. Claude fallback — only if the site doesn't ship structured data
  if (!ANTHROPIC_KEY) {
    if (fromLd) {
      // partial JSON-LD is still useful — return what we have rather than failing
      return { ...fromLd, sourceUrl: url, extractedBy: 'json-ld-partial' };
    }
    throw new Error('This page has no machine-readable recipe data. Add an ANTHROPIC_API_KEY to the Vercel project to enable Claude fallback extraction.');
  }
  const fromClaude = await extractWithClaude(html, url);
  return { ...fromClaude, sourceUrl: url, extractedBy: 'claude' };
}

function extractFromJsonLd(html) {
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

function cleanString(s) {
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

// ISO 8601 duration "PT1H30M" → "1h 30m"
function formatDuration(d) {
  if (!d || typeof d !== 'string') return '';
  const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return d;
  const [, h, mi] = m;
  const parts = [];
  if (h)  parts.push(`${h}h`);
  if (mi) parts.push(`${mi}m`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Claude fallback — laser-targeted on ingredients, measurements, steps
// ---------------------------------------------------------------------------

async function extractWithClaude(html, url) {
  const text = htmlToText(html).slice(0, 60000);
  const prompt = `You are extracting a single recipe from a webpage.

Respond with ONLY a JSON object (no prose, no markdown fences) in exactly this shape:

{
  "title": string,
  "description": string,
  "ingredients": [string, ...],   // each string is ONE ingredient line, including the measurement (e.g. "2 tbsp olive oil")
  "instructions": [string, ...],  // each string is ONE discrete step, in order
  "prepTime": string,             // e.g. "15m", "1h 30m", or "" if not given
  "cookTime": string,
  "totalTime": string,
  "servings": string,             // e.g. "4 servings", "makes 12", or ""
  "image": string,                // best hero image URL, or ""
  "author": string                // recipe author / site name, or ""
}

Rules:
- Strip the writer's life story, ads, and SEO filler. Capture only the recipe itself.
- Keep ingredient measurements EXACTLY as written.
- Each step in "instructions" must be a single coherent action (don't merge multiple steps).
- If a field isn't present on the page, use "" or [].

URL: ${url}

PAGE TEXT:
${text}`;

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
  // Normalize shape — guarantee arrays/strings exist
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

function htmlToText(html) {
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
