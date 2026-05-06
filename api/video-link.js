// api/video-link.js
//
// Mints a short-lived temporary link for an archived asset so the
// browser can render it directly. Auth is per-user.
// Supports both Dropbox and Google Drive via x-storage-provider header.
//
// Request: GET /api/video-link?id=<recipeId>[&kind=thumb]
//          (with storage token header)
//
// kind defaults to 'video' (returns recipe.videoPath link). 'thumb' returns
// recipe.thumbPath link — used by the frontend to display reel thumbnails
// without needing the Dropbox sharing.write scope.

import { getProvider, getToken, ops } from '../lib/storage.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = getToken(req);
  if (!token) return json(res, 401, { error: 'no storage token' });

  const provider = getProvider(req);
  const { readJson, tempLink } = ops(provider);

  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' });
  }

  const id = (req.query.id || '').toString().trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return json(res, 400, { error: 'bad id' });
  }

  const kind = (req.query.kind || 'video').toString();
  if (kind !== 'video' && kind !== 'thumb') {
    return json(res, 400, { error: 'bad kind' });
  }

  try {
    const recipe = await readJson(token, `/recipe-${id}.json`);

    if (kind === 'thumb') {
      if (!recipe.thumbPath || typeof recipe.thumbPath !== 'string') {
        return json(res, 404, { error: 'no archived thumbnail for this recipe' });
      }
      if (!recipe.thumbPath.startsWith('/thumbnails/')) {
        return json(res, 400, { error: 'bad thumb path' });
      }
      const link = await tempLink(token, recipe.thumbPath);
      return json(res, 200, { url: link });
    }

    if (!recipe.videoPath || typeof recipe.videoPath !== 'string') {
      return json(res, 404, { error: 'no archived video for this recipe' });
    }
    if (!recipe.videoPath.startsWith('/videos/')) {
      return json(res, 400, { error: 'bad video path' });
    }
    const link = await tempLink(token, recipe.videoPath);
    return json(res, 200, { url: link });
  } catch (e) {
    if (String(e?.message || e).includes('not_found')) {
      return json(res, 404, { error: 'asset not found' });
    }
    console.error('[video-link]', e);
    return json(res, 500, { error: e.message || 'internal error' });
  }
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}
