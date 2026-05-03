// api/video-link.js
//
// Mints a short-lived Dropbox temporary link for an archived video so the
// browser can stream it via an HTML5 <video> tag.
//
// Request: GET /api/video-link?id=<recipeId>
// Response: { url: "<temp-link>" }
//
// We DON'T accept arbitrary Dropbox paths from the client — only recipeId.
// We look up the recipe, read its videoPath, and use that. This prevents
// passcode holders from probing the App folder.

import { dbxReadJson, dbxTempLink } from '../lib/dropbox.js';

const PASSCODE = process.env.APP_PASSCODE;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const pass = req.headers['x-app-passcode'];
  if (!PASSCODE || pass !== PASSCODE) {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' });
  }

  const id = (req.query.id || '').toString().trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return json(res, 400, { error: 'bad id' });
  }

  try {
    const recipe = await dbxReadJson(`/recipe-${id}.json`);
    if (!recipe.videoPath || typeof recipe.videoPath !== 'string') {
      return json(res, 404, { error: 'no archived video for this recipe' });
    }
    // Defense-in-depth: only allow paths under /videos/
    if (!recipe.videoPath.startsWith('/videos/')) {
      return json(res, 400, { error: 'bad video path' });
    }
    const link = await dbxTempLink(recipe.videoPath);
    return json(res, 200, { url: link });
  } catch (e) {
    if (String(e.message).includes('not_found')) {
      return json(res, 404, { error: 'video not found' });
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
