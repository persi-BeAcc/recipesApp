// api/share.js
//
// Two related routes for the recipe-sharing feature:
//
//   POST /api/share?id=<recipeId>   (with x-dropbox-token of SHARER)
//     → mints a public Dropbox shared link to the recipe's archived mp4
//       (if videoPath is set) and returns it. The caller will encode this
//       URL into the share-link's hash payload alongside the recipe JSON.
//     Response: { videoUrl?: string }
//
//   POST /api/save-shared        (with x-dropbox-token of RECIPIENT)
//     body: { recipe, videoUrl? }
//     → saves the shared recipe into the recipient's library. If videoUrl
//       was provided, downloads the mp4 from there and archives it into
//       the recipient's own Dropbox so they get their own copy.
//     Response: { recipe }   (with new id and videoPath)

import { dbxReadJson, dbxSharedLink, dbxUpload, dbxWriteJson } from '../lib/dropbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }

  // ----- Mint a shared link to a recipe's archived video -----
  const recipeId = (req.query.id || '').toString().trim();
  if (recipeId) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(recipeId)) {
      return json(res, 400, { error: 'bad id' });
    }
    try {
      const recipe = await dbxReadJson(dbxToken, `/recipe-${recipeId}.json`);
      if (!recipe.videoPath) return json(res, 200, { videoUrl: null });
      const url = await dbxSharedLink(dbxToken, recipe.videoPath);
      // Convert preview URL to direct-download URL so a recipient's <video>
      // tag can stream it without rendering Dropbox's preview UI.
      // dropbox.com/s/...?dl=0 → ...?dl=1 (or replace host with dl.dropboxusercontent.com).
      const direct = (url || '').replace(/dl=0$/, 'dl=1').replace(/\?dl=0&/, '?dl=1&');
      return json(res, 200, { videoUrl: direct });
    } catch (e) {
      console.error('[share mint]', e);
      return json(res, 500, { error: e.message || 'could not generate share link' });
    }
  }

  // ----- Save a shared recipe to the recipient's library -----
  const body = await readJsonBody(req);
  if (!body || !body.recipe || typeof body.recipe !== 'object') {
    return json(res, 400, { error: 'missing recipe in body' });
  }

  const recipe = body.recipe;
  const videoUrl = (body.videoUrl || '').toString().trim();

  // Brand-new id — recipient gets their own independent record.
  const id = newId();
  const now = new Date().toISOString();

  let videoPath = null;
  if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
    try {
      // Pull the mp4 from the sharer's public link, write it into the
      // recipient's Dropbox.
      const r = await fetch(videoUrl, { redirect: 'follow' });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0 && buf.length < 100_000_000) {
          videoPath = `/videos/${id}.mp4`;
          await dbxUpload(dbxToken, videoPath, buf);
        }
      }
    } catch (e) {
      console.warn('[save-shared] could not archive video:', e.message);
      videoPath = null;
    }
  }

  const finalRecipe = {
    ...recipe,
    id,
    videoPath,
    tags: recipe.tags || [],
    notes: '',
    rating: 0,
    cooked: 0,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    importedFrom: 'shared',
  };

  try {
    await dbxWriteJson(dbxToken, `/recipe-${id}.json`, finalRecipe);
  } catch (e) {
    console.error('[save-shared] write failed:', e);
    return json(res, 500, { error: 'could not save: ' + (e.message || 'unknown') });
  }

  return json(res, 200, { recipe: finalRecipe });
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
