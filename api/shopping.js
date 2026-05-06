// api/shopping.js
//
// CRUD on the shopping list. Single JSON file at /shopping.json in the
// user's storage (Dropbox or Google Drive).
//
//   GET    /api/shopping       → returns { items: [...] }
//   PUT    /api/shopping       → body { items: [...] } → overwrites the list
//   DELETE /api/shopping       → empties the list

import { getProvider, getToken, ops } from '../lib/storage.js';

const SHOPPING_PATH = '/shopping.json';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = getToken(req);
  if (!token) return json(res, 401, { error: 'no storage token' });

  const provider = getProvider(req);
  const { readJson, writeJson } = ops(provider);

  try {
    if (req.method === 'GET') {
      const list = await loadList(token, readJson);
      return json(res, 200, list);
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.items)) {
        return json(res, 400, { error: 'missing items array' });
      }
      const list = {
        version: 1,
        items: body.items,
        updatedAt: new Date().toISOString(),
      };
      await writeJson(token, SHOPPING_PATH, list);
      return json(res, 200, list);
    }

    if (req.method === 'DELETE') {
      const empty = { version: 1, items: [], updatedAt: new Date().toISOString() };
      await writeJson(token, SHOPPING_PATH, empty);
      return json(res, 200, empty);
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('[shopping]', e);
    return json(res, 500, { error: e.message || 'internal error' });
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported for use by shopping/add.js
// ---------------------------------------------------------------------------

export async function loadList(token, readJsonFn) {
  try {
    const list = await readJsonFn(token, SHOPPING_PATH);
    return {
      version: list.version || 1,
      items: Array.isArray(list.items) ? list.items : [],
      updatedAt: list.updatedAt || null,
    };
  } catch (e) {
    if (String(e?.message || e).includes('not_found')) {
      return { version: 1, items: [], updatedAt: null };
    }
    throw e;
  }
}

export async function saveList(token, items, writeJsonFn) {
  const list = {
    version: 1,
    items,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFn(token, SHOPPING_PATH, list);
  return list;
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
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
