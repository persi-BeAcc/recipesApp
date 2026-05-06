// api/oauth/[action].js
//
// Handles the OAuth dance for per-user authorization — supports both
// Dropbox and Google Drive.
//
//   GET /api/oauth/start?provider=dropbox  → 302 to Dropbox authorize
//   GET /api/oauth/start?provider=gdrive   → 302 to Google authorize
//   GET /api/oauth/callback                → exchanges the auth code,
//                                             returns a tiny HTML page that
//                                             stores the refresh token +
//                                             provider in localStorage and
//                                             redirects to /
//
// The `provider` is embedded in the OAuth `state` param so the callback
// knows which provider initiated the flow without needing a separate route.
//
// Stateless: refresh tokens live in the user's browser. Server's only role
// is the code-for-token exchange (which requires the app secret).

import { ops } from '../../lib/storage.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query.action || '').toString();

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  const redirectUri = `${proto}://${host}/api/oauth/callback`;

  if (action === 'start') {
    const provider = (req.query.provider || 'dropbox').toString().toLowerCase();
    if (provider !== 'dropbox' && provider !== 'gdrive') {
      return htmlError(res, 'Unknown storage provider.');
    }

    // Embed provider in the state so callback knows which flow to finish.
    const nonce = randomString();
    const state = `${provider}:${nonce}`;
    res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

    const { buildAuthorizeUrl } = ops(provider);
    res.writeHead(302, { Location: buildAuthorizeUrl(redirectUri, state) });
    return res.end();
  }

  if (action === 'callback') {
    const code = (req.query.code || '').toString();
    const returnedState = (req.query.state || '').toString();
    const cookieState = parseCookie(req.headers.cookie || '', 'oauth_state');

    // Determine provider from state (format: "provider:nonce")
    const provider = returnedState.split(':')[0] === 'gdrive' ? 'gdrive' : 'dropbox';
    const providerLabel = provider === 'gdrive' ? 'Google Drive' : 'Dropbox';

    if (req.query.error) {
      return htmlError(res, `${providerLabel} authorization was cancelled or denied.`);
    }
    if (!code) {
      return htmlError(res, 'Missing authorization code.');
    }
    if (cookieState && returnedState && cookieState !== returnedState) {
      return htmlError(res, 'OAuth state mismatch — please try connecting again.');
    }

    const { exchangeAuthCode, getCurrentAccount } = ops(provider);

    let tokenResp;
    try {
      tokenResp = await exchangeAuthCode(code, redirectUri);
    } catch (e) {
      console.error('[oauth callback] exchange failed:', e);
      return htmlError(res, `Could not complete ${providerLabel} authorization: ${e.message}`);
    }

    let account = null;
    try { account = await getCurrentAccount(tokenResp.refresh_token); } catch {}

    const accountInfo = account
      ? {
          name: account.name?.display_name || account.name || '',
          email: account.email || '',
        }
      : { name: '', email: '' };

    res.setHeader('Set-Cookie', 'oauth_state=; Path=/; Max-Age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200);
    res.end(connectedPage(tokenResp.refresh_token, accountInfo, provider));
    return;
  }

  res.status(404);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ error: 'unknown action' }));
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function connectedPage(refreshToken, account, provider) {
  const safeName  = htmlEscape(account.name || '');
  const safeEmail = htmlEscape(account.email || '');
  const providerLabel = provider === 'gdrive' ? 'Google Drive' : 'Dropbox';

  // JS-source-safe literals for inlining into the inline <script>. Each
  // is the result of one JSON.stringify on the desired stored value, so
  // the inlined source reads as `setItem(key, "stored value")`.
  const tokenLit    = JSON.stringify(refreshToken);
  const accountLit  = JSON.stringify(JSON.stringify({ name: account.name || '', email: account.email || '' }));
  const providerLit = JSON.stringify(provider);

  // Token key varies by provider
  const tokenKey   = provider === 'gdrive' ? 'recipes-gdrive-token-v1' : 'recipes-dropbox-token-v1';
  const accountKey = provider === 'gdrive' ? 'recipes-gdrive-account-v1' : 'recipes-dropbox-account-v1';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connected — Recipes</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: oklch(0.975 0.010 90); color: oklch(0.22 0.014 85); display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { background: oklch(0.995 0.005 90); border-radius: 16px; padding: 36px 28px; max-width: 380px; text-align: center; box-shadow: 0 8px 24px oklch(0 0 0 / 0.06); }
    .check { width: 56px; height: 56px; border-radius: 50%; background: oklch(0.42 0.058 125); color: white; display: grid; place-items: center; margin: 0 auto 14px; font-size: 26px; }
    h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.02em; }
    p { font-size: 14px; color: oklch(0.44 0.012 85); margin: 0 0 16px; line-height: 1.5; }
    .who { font-weight: 600; color: oklch(0.22 0.014 85); }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Connected!</h1>
    <p>Your ${htmlEscape(providerLabel)} is linked${safeName ? ` as <span class="who">${safeName}</span>` : ''}${safeEmail ? `<br/><span style="font-size:12px;opacity:0.7">${safeEmail}</span>` : ''}</p>
    <p style="font-size:13px">Taking you back to the app…</p>
  </div>
  <script>
    try {
      // Clear any tokens from the OTHER provider — user picks one.
      ${provider === 'gdrive'
        ? `localStorage.removeItem('recipes-dropbox-token-v1'); localStorage.removeItem('recipes-dropbox-account-v1');`
        : `localStorage.removeItem('recipes-gdrive-token-v1'); localStorage.removeItem('recipes-gdrive-account-v1');`
      }
      localStorage.setItem('${tokenKey}', ${tokenLit});
      localStorage.setItem('${accountKey}', ${accountLit});
      localStorage.setItem('recipes-provider-v1', ${providerLit});
    } catch (e) {}
    setTimeout(() => { window.location.href = '/'; }, 800);
  </script>
</body>
</html>`;
}

function htmlError(res, msg) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(400);
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connection failed — Recipes</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: oklch(0.975 0.010 90); display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: white; border-radius: 16px; padding: 36px 28px; max-width: 380px; text-align: center; box-shadow: 0 8px 24px oklch(0 0 0 / 0.06); }
  h1 { font-size: 20px; margin: 0 0 8px; color: oklch(0.40 0.16 25); }
  p { font-size: 14px; color: oklch(0.44 0.012 85); }
  a { color: oklch(0.42 0.058 125); font-weight: 600; }
</style></head>
<body><div class="card"><h1>Couldn't connect</h1><p>${htmlEscape(msg)}</p><p><a href="/">← Back to Recipes</a></p></div></body></html>`);
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseCookie(header, name) {
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function randomString() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
