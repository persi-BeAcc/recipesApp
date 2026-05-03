// api/oauth.js
//
// DEPRECATED — this file used to handle OAuth via query-string `?action=...`,
// but the path-based dynamic route at `api/oauth/[action].js` is what
// actually serves /api/oauth/start and /api/oauth/callback now (matches
// the redirect URI registered in the Dropbox app config).
//
// Kept around as a no-op only because the runtime can't delete files in
// the mounted workspace from the build step. Safe to delete this file
// from your local repo.

export default function handler(req, res) {
  res.status(410);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify({
    error: 'gone',
    message: 'This endpoint moved. Use /api/oauth/start or /api/oauth/callback.',
  }));
}
