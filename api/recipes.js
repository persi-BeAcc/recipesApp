// api/recipes.js
//
// Single Vercel serverless function:
//   1. Gates every request behind a shared APP_PASSCODE header.
//   2. Reads/writes a per-recipe JSON store in the Dropbox "App folder"
//      (Apps/Recipes/) using a long-lived refresh token owned by Bea.
//   3. Extracts new recipes from a URL — JSON-LD Recipe schema first,
//      Claude API fallback when the page has none.
//
// Routes (all under /api/recipes):
//   GET    /api/recipes              → list all recipes (full bodies)
//   GET    /api/recipes?id=xyz       → fetch one recipe
//   POST   /api/recipes?extract=1    → body {url} → returns parsed recipe (no save)
//   PUT    /api/recipes?id=xyz       → body recipe → upsert
//   DELETE /api/recipes?id=xyz       → delete
//
// We deliberately do NOT use the Dropbox SDK. Its v10 download path calls
// `res.buffer()` (a node-fetch API) which doesn't exist in Vercel's native
// fetch runtime. Calling Dropbox's HTTP API directly with `fetch` sidesteps
// the issue entirely and removes a dependency.

const PASSCODE      = process.env.APP_PASSCODE;
const APP_KEY       = process.env.DROPBOX_APP_KEY;
const APP_SECRET    = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const pass = req.headers['x-app-passcode'];
  if (!PASSCODE || pass !== PASSCODE) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    return json(res, 500, { error: 'server missing Dropbox credentials' });
  }

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
      const list = await dbxApi('files/list_folder', { path: '' });
      const entries = list.entries || [];
      const files = entries.filter(e =>
        (e['.tag'] === 'file' || e.tag === 'file') &&
        typeof e.name === 'string' &&
        e.name.toLowerCase().endsWith('.json')
      );
      const recipes = await Promise.all(
        files.map(async f => {
          try {
            const path = f.path_lower || f.path_display || ('/' + f.name);
            const text = await dbxDownload(path);
            return JSON.parse(text);
          } catch (err) {
            console.error('[list] failed for', f.name, ':', err && err.message);
            return null;
          }
        })
      );
      return json(res, 200, { recipes: recipes.filter(Boolean) });
    }

    // -------- read one --------
    if (method === 'GET' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      const text = await dbxDownload(`/recipe-${id}.json`);
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
      await dbxUpload(`/recipe-${id}.json`, JSON.stringify(recipe, null, 2));
      return json(res, 200, recipe);
    }

    // -------- delete --------
    if (method === 'DELETE' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      try {
        await dbxApi('files/delete_v2', { path: `/recipe-${id}.json` });
      } catch (e) {
        // tolerate "not_found" so deletes are idempotent
        if (!String(e && e.message).includes('not_found')) throw e;
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
// Dropbox HTTP client (no SDK)
// ---------------------------------------------------------------------------

// Cache the access token across warm invocations of the same container.
// Tokens last 4h; we refresh on demand if expired or missing.
let _accessToken = null;
let _accessTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_accessToken && now < _accessTokenExpiresAt - 60_000) {
    return _accessToken;
  }
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox auth failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  _accessToken = data.access_token;
  _accessTokenExpiresAt = now + (data.expires_in || 14400) * 1000;
  return _accessToken;
}

// Standard Dropbox JSON RPC endpoint (api.dropboxapi.com).
async function dbxApi(endpoint, args) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Download endpoint lives on content.dropboxapi.com and uses the Dropbox-API-Arg header.
async function dbxDownload(path) {
  const token = await getAccessToken();
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox download failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.text();
}

// Upload endpoint also on content.dropboxapi.com.
async function dbxUpload(path, contents) {
  const token = await getAccessToken();
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'overwrite',
        mute: true,
        autorename: false,
        strict_conflict: false,
      }),
    },
    body: contents,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox upload failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
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
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return null; }
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

  const fromLd = extractFromJsonLd(html);
  if (fromLd && fromLd.ingredients.length && fromLd.instructions.length) {
    return { ...fromLd, sourceUrl: url, extractedBy: 'json-ld' };
  }

  if (!ANTHROPIC_KEY) {
    if (fromLd) return { ...fromLd, sourceUrl: url, extractedBy: 'json-ld-partial' };
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
// Claude fallback
// ---------------------------------------------------------------------------

async function extractWithClaude(html, url) {
  const text = htmlToText(html).slice(0, 60000);
  const prompt = `You are extracting a single recipe from a webpage.

Respond with ONLY a JSON object (no prose, no markdown fences) in exactly this shape:

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

Rules:
- Strip the writer's life story, ads, and SEO filler. Capture only the recipe itself.
- Keep ingredient measurements EXACTLY as written.
- Each step in "instructions" must be a single coherent action.
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
