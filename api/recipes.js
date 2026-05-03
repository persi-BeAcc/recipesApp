// api/recipes.js
//
// Recipe CRUD + synchronous URL extraction. Auth is per-user: every request
// must carry the user's Dropbox refresh token in the `x-dropbox-token` header.

import {
  dbxApi,
  dbxReadJson,
  dbxWriteJson,
  dbxDelete,
  dbxListFolder,
} from '../lib/dropbox.js';
import { extractFromUrl } from '../lib/recipe-extract.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  const { method, query } = req;
  const id = (query.id || '').toString().trim();

  try {
    // -------- extract --------
    if (method === 'POST' && (query.extract === '1' || query.extract === 'true')) {
      const body = await readJsonBody(req);
      const url = (body && body.url || '').toString().trim();
      if (!url) return json(res, 400, { error: 'missing url' });
      const recipe = await extractFromUrl(url);
      return json(res, 200, recipe);
    }

    // -------- list --------
    if (method === 'GET' && !id) {
      const entries = await dbxListFolder(dbxToken, '');
      const files = entries.filter(e =>
        (e['.tag'] === 'file' || e.tag === 'file') &&
        typeof e.name === 'string' &&
        e.name.toLowerCase().endsWith('.json') &&
        e.name.toLowerCase().startsWith('recipe-')
      );
      // Cap concurrent Dropbox reads — see mapWithLimit comment.
      const recipes = await mapWithLimit(files, 8, async f => {
        try {
          const path = f.path_lower || f.path_display || ('/' + f.name);
          return await dbxReadJson(dbxToken, path);
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
      const recipe = await dbxReadJson(dbxToken, `/recipe-${id}.json`);
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
      await dbxWriteJson(dbxToken, `/recipe-${id}.json`, recipe);
      return json(res, 200, recipe);
    }

    // -------- delete --------
    if (method === 'DELETE' && id) {
      if (!isSafeId(id)) return json(res, 400, { error: 'bad id' });
      await dbxDelete(dbxToken, `/recipe-${id}.json`);
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

// Concurrency-limited map. Same shape as Promise.all(items.map(fn)), but
// runs at most `limit` async operations in flight at any time.
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
