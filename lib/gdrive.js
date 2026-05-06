// lib/gdrive.js
//
// Per-user Google Drive HTTP client. Mirrors lib/dropbox.js — every API
// caller passes their own refresh token; the lib refreshes its own access
// token and caches per-token.
//
// All recipe files live in a dedicated "Recipes" app folder created inside
// the user's Drive root. Videos go into a "Recipes/videos" subfolder.

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function requireCreds() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars required');
  }
}

// ---------------------------------------------------------------------------
// Per-token access-token cache. Identical pattern to lib/dropbox.js.
// Google access tokens last 1h; we mint fresh ~60s before expiry.
// ---------------------------------------------------------------------------

const _tokenCache = new Map();

export async function getAccessToken(refreshToken) {
  requireCreds();
  if (!refreshToken) throw new Error('Google refresh token missing');
  const now = Date.now();
  const cached = _tokenCache.get(refreshToken);
  if (cached && now < cached.expiresAt - 60_000) return cached.accessToken;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google auth failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  _tokenCache.set(refreshToken, {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// OAuth helpers — used by /api/oauth/start and /api/oauth/callback.
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(redirectUri, state) {
  requireCreds();
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('redirect_uri', redirectUri);
  // Drive file scope — only files created by this app are accessible.
  u.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email');
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeAuthCode(code, redirectUri) {
  requireCreds();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google code exchange failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, ... }
}

export async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).catch(() => {});
  _tokenCache.delete(refreshToken);
}

export async function getCurrentAccount(refreshToken) {
  const token = await getAccessToken(refreshToken);
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google account fetch (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  // Normalize to match the shape our app expects
  return {
    account_id: data.id,
    name: { display_name: data.name || '' },
    email: data.email || '',
  };
}

// ---------------------------------------------------------------------------
// App folder management. Google Drive doesn't have a native "app folder"
// scope like Dropbox's App folder mode. We use drive.file scope and manage
// a top-level "Recipes" folder ourselves. All paths are relative to this
// folder — callers pass e.g. "/recipe-abc.json" just like with Dropbox.
// ---------------------------------------------------------------------------

// Per-token cache of the app folder ID.
const _folderCache = new Map();

async function getOrCreateFolder(token, parentId, name) {
  // Search for existing folder
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false` +
            (parentId ? ` and '${parentId}' in parents` : '');
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!searchRes.ok) {
    const t = await searchRes.text();
    throw new Error(`Drive folder search failed (${searchRes.status}): ${t.slice(0, 200)}`);
  }
  const { files } = await searchRes.json();
  if (files && files.length > 0) return files[0].id;

  // Create it
  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {}),
  };
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(meta),
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error(`Drive folder create failed (${createRes.status}): ${t.slice(0, 200)}`);
  }
  const created = await createRes.json();
  return created.id;
}

async function getAppFolderId(refreshToken) {
  const cached = _folderCache.get(refreshToken);
  if (cached) return cached;
  const token = await getAccessToken(refreshToken);
  const folderId = await getOrCreateFolder(token, null, 'Recipes');
  _folderCache.set(refreshToken, folderId);
  return folderId;
}

// Resolve a path like "/recipe-abc.json" or "/videos/vid.mp4" or
// "/jobs/job-abc.json" to a parent folder ID.
async function resolveParentFolder(refreshToken, path) {
  const token = await getAccessToken(refreshToken);
  const appFolderId = await getAppFolderId(refreshToken);
  const parts = path.replace(/^\//, '').split('/');
  // The last part is the filename; navigate intermediate folders
  let parentId = appFolderId;
  for (let i = 0; i < parts.length - 1; i++) {
    parentId = await getOrCreateFolder(token, parentId, parts[i]);
  }
  return parentId;
}

// Find a file by name inside a specific parent folder.
async function findFile(token, parentId, name) {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive findFile failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const { files } = await res.json();
  return files && files.length > 0 ? files[0] : null;
}

// ---------------------------------------------------------------------------
// File operations — every function takes refreshToken as the first arg,
// matching the Dropbox lib interface.
// ---------------------------------------------------------------------------

export async function gdriveListFolder(refreshToken, path = '') {
  const token = await getAccessToken(refreshToken);
  let parentId;
  if (!path || path === '' || path === '/') {
    parentId = await getAppFolderId(refreshToken);
  } else {
    // path like "/jobs" — we need to find that subfolder
    const appFolderId = await getAppFolderId(refreshToken);
    const folderName = path.replace(/^\//, '').replace(/\/$/, '');
    const folder = await findFile(token, appFolderId, folderName);
    if (!folder) {
      // If subfolder doesn't exist, return empty — consistent with Dropbox not_found
      throw new Error(`path/not_found/${path}`);
    }
    parentId = folder.id;
  }

  const q = `'${parentId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=1000&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive list failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  // Map to Dropbox-compatible entry shape
  return (data.files || []).map(f => ({
    '.tag': f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
    name: f.name,
    id: f.id,
    path_lower: f.name.toLowerCase(),
    path_display: f.name,
    server_modified: f.modifiedTime,
  }));
}

export async function gdriveDownloadText(refreshToken, path) {
  const token = await getAccessToken(refreshToken);
  const parentId = await resolveParentFolder(refreshToken, path);
  const fileName = path.split('/').pop();
  const file = await findFile(token, parentId, fileName);
  if (!file) throw new Error(`Drive download: path/not_found/${path}`);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive download (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.text();
}

export async function gdriveReadJson(refreshToken, path) {
  const text = await gdriveDownloadText(refreshToken, path);
  return JSON.parse(text);
}

export async function gdriveUpload(refreshToken, path, contents) {
  const token = await getAccessToken(refreshToken);
  const parentId = await resolveParentFolder(refreshToken, path);
  const fileName = path.split('/').pop();

  // Check if file already exists — overwrite if so
  const existing = await findFile(token, parentId, fileName);

  if (existing) {
    // Update existing file content (PATCH to update)
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: contents,
      },
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Drive update (${res.status}): ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  // Create new file — multipart upload
  const boundary = '---recipes-boundary-' + Date.now();
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentId],
  });

  const bodyParts = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    metadata,
    `\r\n--${boundary}\r\n`,
    'Content-Type: application/octet-stream\r\n\r\n',
  ];

  // Build the multipart body
  const textEncoder = new TextEncoder();
  const prefix = textEncoder.encode(bodyParts.join(''));
  const suffix = textEncoder.encode(`\r\n--${boundary}--`);
  const contentBuf = typeof contents === 'string' ? textEncoder.encode(contents) : contents;

  const body = new Uint8Array(prefix.length + contentBuf.length + suffix.length);
  body.set(prefix, 0);
  body.set(contentBuf instanceof Uint8Array ? contentBuf : new Uint8Array(contentBuf), prefix.length);
  body.set(suffix, prefix.length + contentBuf.length);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive upload (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

export function gdriveWriteJson(refreshToken, path, obj) {
  return gdriveUpload(refreshToken, path, JSON.stringify(obj, null, 2));
}

export async function gdriveDelete(refreshToken, path) {
  const token = await getAccessToken(refreshToken);
  const parentId = await resolveParentFolder(refreshToken, path);
  const fileName = path.split('/').pop();
  const file = await findFile(token, parentId, fileName);
  if (!file) return; // Already gone — match Dropbox's silent not_found behavior

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    throw new Error(`Drive delete (${res.status}): ${t.slice(0, 200)}`);
  }
}

// Short-lived download URL — for video streaming in detail view.
// Google Drive files can be downloaded via the API, but we need a URL
// the browser can hit directly. We use a webContentLink (if file is
// small enough) or create a short-lived signed URL.
export async function gdriveTempLink(refreshToken, path) {
  const token = await getAccessToken(refreshToken);
  const parentId = await resolveParentFolder(refreshToken, path);
  const fileName = path.split('/').pop();
  const file = await findFile(token, parentId, fileName);
  if (!file) throw new Error(`Drive tempLink: path/not_found/${path}`);

  // Make the file accessible via a direct download link by fetching
  // webContentLink. This requires the file to have at least "anyone
  // with link" view access, so we temporarily add that permission.
  // For simplicity, we'll return an API download URL with the token embedded.
  // The token lives for ~1h which is equivalent to Dropbox's 4h temp links.
  return `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&access_token=${encodeURIComponent(token)}`;
}

// Shared link — public URL for sharing recipe videos.
export async function gdriveSharedLink(refreshToken, path) {
  const token = await getAccessToken(refreshToken);
  const parentId = await resolveParentFolder(refreshToken, path);
  const fileName = path.split('/').pop();
  const file = await findFile(token, parentId, fileName);
  if (!file) throw new Error(`Drive sharedLink: path/not_found/${path}`);

  // Grant "anyone with link" reader permission
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}/permissions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    },
  ).catch(() => {}); // May already have the permission

  // Get the webContentLink for direct download
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}?fields=webContentLink,webViewLink`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) {
    const t = await metaRes.text();
    throw new Error(`Drive sharedLink meta (${metaRes.status}): ${t.slice(0, 200)}`);
  }
  const meta = await metaRes.json();
  // webContentLink is a direct download link; webViewLink opens in browser
  return meta.webContentLink || meta.webViewLink || '';
}
