// api/shopping/add.js
//
// Smart-add for the shopping list. One endpoint, three input modes:
//
//   POST /api/shopping/add
//     body: { items: ["..."], fromRecipe?: "r-id" }
//     → typed text or recipe-ingredients flow
//
//   POST /api/shopping/add
//     body: { image: "data:image/jpeg;base64,...", mimeType: "image/jpeg" }
//     → snap of a written/printed shopping list, Claude vision OCRs it
//
// Server reads existing list from Dropbox, calls Claude with both, applies
// the resulting updates (skip / merge / add), saves the new list, returns it.

import { loadList, saveList } from '../shopping.js';
import { processNewItems, processPhoto, applyUpdates } from '../../lib/shopping.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'missing body' });

  const fromRecipe = body.fromRecipe ? String(body.fromRecipe).slice(0, 64) : null;

  try {
    const current = await loadList(dbxToken);

    let result;
    if (body.image) {
      // Photo mode — accept a data URL or raw base64
      const dataUrl = String(body.image);
      const m = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
      const imageBase64 = m ? m[2] : dataUrl;
      const mimeType    = m ? m[1] : (body.mimeType || 'image/jpeg');
      // Cap size — Claude vision accepts up to ~5MB; reject huge uploads up front.
      if (imageBase64.length > 7_000_000) {
        return json(res, 413, { error: 'image too large (max ~5MB)' });
      }
      result = await processPhoto({ existing: current.items, imageBase64, mimeType });
    } else if (Array.isArray(body.items) && body.items.length > 0) {
      // Typed / recipe mode — list of strings
      const newItems = body.items
        .map(s => String(s || '').trim())
        // Drop empty lines and ingredient-section headings (— Sauce —)
        .filter(s => s && !/^—.*—$/.test(s))
        .slice(0, 80);  // sanity cap
      if (!newItems.length) return json(res, 400, { error: 'no usable items in input' });
      result = await processNewItems({ existing: current.items, newItems });
    } else {
      return json(res, 400, { error: 'must provide items[] or image' });
    }

    const nextItems = applyUpdates(current.items, result.updates, { fromRecipe });
    const saved = await saveList(dbxToken, nextItems);
    const __usage = result.usage ? [result.usage] : [];
    return json(res, 200, { ...saved, updates: result.updates, __usage });
  } catch (e) {
    console.error('[shopping/add]', e);
    return json(res, 500, { error: e.message || 'internal error' });
  }
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
