// api/whoami.js
//
// Returns the connected user's display name + email so Settings can show
// "Connected as Alice (alice@example.com)". Works with both Dropbox and
// Google Drive — reads x-storage-provider header to pick the right backend.
//
// Request: GET /api/whoami   (with x-dropbox-token / x-storage-token header)

import { getProvider, getToken, ops } from '../lib/storage.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = getToken(req);
  if (!token) return json(res, 401, { error: 'no storage token' });

  const provider = getProvider(req);
  const { getCurrentAccount, revokeToken } = ops(provider);

  // POST /api/whoami?action=disconnect → revoke the token server-side.
  if (req.method === 'POST' && req.query.action === 'disconnect') {
    try { await revokeToken(token); } catch {}
    return json(res, 200, { ok: true });
  }

  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' });
  }

  try {
    const account = await getCurrentAccount(token);
    return json(res, 200, {
      name:  account?.name?.display_name || account?.name || '',
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
