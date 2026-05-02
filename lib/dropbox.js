// lib/dropbox.js
//
// Shared Dropbox HTTP client. We deliberately do NOT use the dropbox SDK —
// its v10 download path calls `res.buffer()` which doesn't exist in Vercel's
// native fetch runtime. Calling Dropbox's HTTP API directly with fetch is
// reliable, dependency-free, and easy to read.
//
// All paths are relative to the App folder root (Apps/Recipes/) because
// the Dropbox app is registered in App folder mode.

const APP_KEY       = process.env.DROPBOX_APP_KEY;
const APP_SECRET    = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

// Cache the access token across warm container invocations. Tokens last 4h;
// we mint a new one ~60s before expiry so a refresh never overlaps a request.
let _accessToken = null;
let _accessTokenExpiresAt = 0;

export async function getAccessToken() {
  const now = Date.now();
  if (_accessToken && now < _accessTokenExpiresAt - 60_000) {
    return _accessToken;
  }
  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    throw new Error('Dropbox credentials missing from env');
  }
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dropbox auth failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  _accessToken = data.access_token;
  _accessTokenExpiresAt = now + (data.expires_in || 14400) * 1000;
  return _accessToken;
}

// Standard Dropbox JSON RPC (api.dropboxapi.com).
export async function dbxApi(endpoint, args) {
  const token = await getAccessToken();
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

// Download text content from content.dropboxapi.com.
export async function dbxDownloadText(path) {
  const token = await getAccessToken();
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

// Read a JSON file (small wrapper around download + parse).
export async function dbxReadJson(path) {
  const text = await dbxDownloadText(path);
  return JSON.parse(text);
}

// Upload bytes (string or Buffer) to a path. Always overwrites.
export async function dbxUpload(path, contents) {
  const token = await getAccessToken();
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

// Convenience helper: write a JSON-serializable object as pretty JSON.
export function dbxWriteJson(path, obj) {
  return dbxUpload(path, JSON.stringify(obj, null, 2));
}

// Delete is idempotent: tolerate not_found.
export async function dbxDelete(path) {
  try {
    await dbxApi('files/delete_v2', { path });
  } catch (e) {
    if (!String(e && e.message).includes('not_found')) throw e;
  }
}

// List files under a folder (returns the raw entries array).
export async function dbxListFolder(path = '') {
  const result = await dbxApi('files/list_folder', { path });
  return result.entries || [];
}

// Mint a short-lived (4h) public URL for streaming a file. Useful for the
// future "archive mp4" feature where the recipe detail view fetches a fresh
// playable URL on demand.
export async function dbxTempLink(path) {
  const result = await dbxApi('files/get_temporary_link', { path });
  return result.link;
}
