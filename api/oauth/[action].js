// api/oauth/[action].js
//
// Handles the Dropbox OAuth dance for per-user authorization.
//   GET /api/oauth/start    → 302 redirects to Dropbox authorize page
//   GET /api/oauth/callback → exchanges the auth code, returns a tiny HTML
//                              page that stuffs the refresh token into
//                              localStorage and redirects to /
//
// Path-style URLs because Dropbox redirect URIs are matched as exact
// strings — `/api/oauth/callback` is what you register in the Dropbox
// app's redirect-URIs list.
//
// Stateless: refresh tokens live in the user's browser. Server's only role
// is the code-for-token exchange (which requires the app secret).

import {
  buildAuthorizeUrl,
  exchangeAuthCode,
  getCurrentAccount,
} from '../../lib/dropbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Vercel's file-based dynamic route puts the path segment in req.query.action.
  const action = (req.query.action || '').toString();

  // Build the redirect URI from the request's host so production AND preview
  // deployments work without code changes — both must be added to Dropbox's
  // allowed redirect URIs.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  const redirectUri = `${proto}://${host}/api/oauth/callback`;

  if (action === 'start') {
    // Lightweight CSRF defense: random state, stored as a cookie, verified
    // on callback.
    const state = randomString();
    res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    res.writeHead(302, { Location: buildAuthorizeUrl(redirectUri, state) });
    return res.end();
  }

  if (action === 'callback') {
    const code = (req.query.code || '').toString();
    const returnedState = (req.query.state || '').toString();
    const cookieState = parseCookie(req.headers.cookie || '', 'oauth_state');

    if (req.query.error) {
      return htmlError(res, 'Dropbox authorization was cancelled or denied.');
    }
    if (!code) {
      return htmlError(res, 'Missing authorization code.');
    }
    if (cookieState && returnedState && cookieState !== returnedState) {
      return htmlError(res, 'OAuth state mismatch — please try connecting again.');
    }

    let tokenResp;
    try {
      tokenResp = await exchangeAuthCode(code, redirectUri);
    } catch (e) {
      console.error('[oauth callback] exchange failed:', e);
      return htmlError(res, 'Could not complete Dropbox authorization: ' + e.message);
    }

    let account = null;
    try { account = await getCurrentAccount(tokenResp.refresh_token); } catch {}

    const accountInfo = account
      ? { name: account.name?.display_name || '', email: account.email || '' }
      : { name: '', email: '' };

    res.setHeader('Set-Cookie', 'oauth_state=; Path=/; Max-Age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200);
    res.end(connectedPage(tokenResp.refresh_token, accountInfo));
    return;
  }

  res.status(404);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ error: 'unknown action' }));
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function connectedPage(refreshToken, account) {
  const safeName  = htmlEscape(account.name || '');
  const safeEmail = htmlEscape(account.email || '');
  const tokenJson    = JSON.stringify(refreshToken);
  const accountJson  = JSON.stringify({ name: account.name || '', email: account.email || '' });
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
    <p>Your Dropbox is linked${safeName ? ` as <span class="who">${safeName}</span>` : ''}${safeEmail ? `<br/><span style="font-size:12px;opacity:0.7">${safeEmail}</span>` : ''}</p>
    <p style="font-size:13px">Taking you back to the app…</p>
  </div>
  <script>
    try {
      localStorage.setItem('recipes-dropbox-token-v1', JSON.parse(${JSON.stringify(tokenJson)}));
      localStorage.setItem('recipes-dropbox-account-v1', JSON.stringify(${JSON.stringify(accountJson)}));
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
