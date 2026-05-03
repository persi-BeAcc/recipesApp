// api/whoami.js
//
// Returns the connected Dropbox user's display name + email so Settings
// can show "Connected as Alice (alice@example.com)" without storing
// account info anywhere except localStorage.
//
// Request: GET /api/whoami   (with x-dropbox-token header)

import { getCurrentAccount, revokeRefreshToken } from '../lib/dropbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  // POST /api/whoami?action=disconnect → revoke the token server-side.
  if (req.method === 'POST' && req.query.action === 'disconnect') {
    try { await revokeRefreshToken(dbxToken); } catch {}
    return json(res, 200, { ok: true });
  }

  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' });
  }

  try {
    const account = await getCurrentAccount(dbxToken);
    return json(res, 200, {
      name:  account?.name?.display_name || '',
      email: account?.email || '',
      accountId: account?.account_id || '',
    });
  } catch (e) {
    console.error('[whoami]', e);
    return json(res, 401, { error: e.message || 'invalid token' });
  }
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}
