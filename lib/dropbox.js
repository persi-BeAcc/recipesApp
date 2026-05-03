// lib/dropbox.js
//
// Per-user Dropbox HTTP client. Every API caller passes their own refresh
// token; the lib refreshes its own access token and caches per-token.
//
// We deliberately do NOT use the dropbox SDK — its v10 download path calls
// `res.buffer()` which doesn't exist in Vercel's native fetch runtime.
//
// All paths are relative to the App folder root (Apps/Recipes/) because
// the Dropbox app is registered in App folder mode. With per-user OAuth,
// each user's tokens grant access to *their* App folder — Dropbox enforces
// the isolation, the lib just talks HTTP.

const APP_KEY    = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  throw new Error('DROPBOX_APP_KEY and DROPBOX_APP_SECRET env vars required');
}

// ---------------------------------------------------------------------------
// Per-token access-token cache. A single Vercel function instance might
// serve multiple users; their refresh tokens get distinct cached access
// tokens. Tokens last 4h; we mint fresh ~60s before expiry.
// ---------------------------------------------------------------------------

const _tokenCache = new Map();

export async function getAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('Dropbox refresh token missing');
  const now = Date.now();
  const cached = _tokenCache.get(refreshToken);
  if (cached && now < cached.expiresAt - 60_000) return cached.accessToken;

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox auth failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  _tokenCache.set(refreshToken, {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 14400) * 1000,
  });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// OAuth helpers — used by /api/oauth/start and /api/oauth/callback.
// ---------------------------------------------------------------------------

// Build the URL we redirect the user to so they can authorize our app
// against their own Dropbox. App-folder mode + offline access type.
export function buildAuthorizeUrl(redirectUri, state) {
  const u = new URL('https://www.dropbox.com/oauth2/authorize');
  u.searchParams.set('client_id', APP_KEY);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('token_access_type', 'offline');
  u.searchParams.set('redirect_uri', redirectUri);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

// Exchange the auth code that comes back to /api/oauth/callback for a
// long-lived refresh_token (which is what the client will store).
export async function exchangeAuthCode(code, redirectUri) {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: APP_KEY,
      client_secret: APP_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox code exchange failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, account_id, uid, ... }
}

// Optional cleanup on disconnect — invalidates the refresh token server-side
// even if it's still in the user's localStorage.
export async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  const accessToken = await getAccessToken(refreshToken).catch(() => null);
  if (!accessToken) return;
  await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => {});
  _tokenCache.delete(refreshToken);
}

// Fetch the connected user's account info — used to show "Connected as ..."
// in the settings sheet.
export async function getCurrentAccount(refreshToken) {
  const token = await getAccessToken(refreshToken);
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox account fetch (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json(); // { account_id, name: { display_name }, email, ... }
}

// ---------------------------------------------------------------------------
// File operations — every function takes refreshToken as the first arg.
// ---------------------------------------------------------------------------

export async function dbxApi(refreshToken, endpoint, args) {
  const token = await getAccessToken(refreshToken);
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox ${endpoint} (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function dbxDownloadText(refreshToken, path) {
  const token = await getAccessToken(refreshToken);
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox download (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.text();
}

export async function dbxReadJson(refreshToken, path) {
  const text = await dbxDownloadText(refreshToken, path);
  return JSON.parse(text);
}

export async function dbxUpload(refreshToken, path, contents) {
  const token = await getAccessToken(refreshToken);
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'overwrite',
        mute: true,
        autorename: false,
        strict_conflict: false,
      }),
    },
    body: contents,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox upload (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

export function dbxWriteJson(refreshToken, path, obj) {
  return dbxUpload(refreshToken, path, JSON.stringify(obj, null, 2));
}

export async function dbxDelete(refreshToken, path) {
  try {
    await dbxApi(refreshToken, 'files/delete_v2', { path });
  } catch (e) {
    if (!String(e && e.message).includes('not_found')) throw e;
  }
}

export async function dbxListFolder(refreshToken, path = '') {
  const result = await dbxApi(refreshToken, 'files/list_folder', { path });
  return result.entries || [];
}

// Short-lived (4h) URL — used to stream archived videos in the detail view.
export async function dbxTempLink(refreshToken, path) {
  const result = await dbxApi(refreshToken, 'files/get_temporary_link', { path });
  return result.link;
}

// Long-lived public-readable shared link — used by the share-recipe-with-video
// feature so a recipient can download the mp4 from the original sharer's
// Dropbox without needing access to that account.
export async function dbxSharedLink(refreshToken, path) {
  // Try to create. If the file already has a shared link, this fails with a
  // specific error and we fetch the existing one instead.
  try {
    const result = await dbxApi(refreshToken, 'sharing/create_shared_link_with_settings', {
      path,
      settings: { audience: 'public', access: 'viewer', allow_download: true },
    });
    return result.url;
  } catch (e) {
    if (String(e.message).includes('shared_link_already_exists')) {
      const existing = await dbxApi(refreshToken, 'sharing/list_shared_links', { path, direct_only: true });
      const link = (existing.links || [])[0];
      if (link) return link.url;
    }
    throw e;
  }
}
