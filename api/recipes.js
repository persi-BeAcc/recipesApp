// api/recipes.js
//
// Recipe CRUD + synchronous URL extraction. Auth is per-user: every request
// must carry the user's storage refresh token. Provider is determined by
// x-storage-provider header ('dropbox' | 'gdrive').

import { getProvider, getToken, ops } from '../lib/storage.js';
import { extractFromUrl } from '../lib/recipe-extract.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = getToken(req);
  if (!token) return json(res, 401, { error: 'no storage token' });

  const provider = getProvider(req);
  const { readJson, writeJson, remove, listFolder } = ops(provider);

  const { method, query } = req;
  const id = (query.id || '').toString().trim();

  try {
    // -------- extract --------
    if (method === 'POST' && (query.extract === '1' || query.extract === 'true')) {
      const body = await readJsonBody(req);
      const url = (body && body.url || '').toString().trim();
      if (!url) return json(res, 400, { error: 'missing url' });
      const ALLOWED_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh'];
      const language = body && ALLOWED_LANGS.includes(body.language) ? body.language : '';
      const recipe = await extractFromUrl(url, { language });
      return json(res, 200, recipe);
    }

    // -------- list --------
    if (method === 'GET' && !id) {
      const entries = await listFolder(token, '');
      const files = entries.filter(e =>
        (e['.tag'] === 'file' || e.tag === 'file') &&
        typeof e.name === 'string' &&
        e.name.toLowerCase().endsWith('.json') &&
        e.name.toLowerCase().startsWith('recipe-')
      );
      const recipes = await mapWithLimit(files, 8, async f => {
        try {
          return await readJson(token, '/' + f.name);
        } catch (err) {
          console.error('[list] failed for', f.name, ':', err && err.message);
          return null;
        }
      });
      return json(res, 200, { recipes: recipes.filter(Boolean) });
    }

    // -------- read one --------
    if (method === 'GET' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      const recipe = await readJson(token, `/recipe-${id}.json`);
      return json(res, 200, recipe);
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
      await writeJson(token, `/recipe-${id}.json`, recipe);
      return json(res, 200, recipe);
    }

    // -------- delete --------
    if (method === 'DELETE' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      await remove(token, `/recipe-${id}.json`);
      return json(res, 200, { ok: true, id });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('[recipes api]', e);
    const msg = e && (e.message || e.error_summary) ? (e.message || e.error_summary) : 'internal error';
    return json(res, 500, { error: String(msg).slice(0, 500) });
  }
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

function isSafeId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
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
