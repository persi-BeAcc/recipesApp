// api/share-from-shortcut.js
//
// Receives a URL from an iOS Shortcut share-sheet handler and queues a
// recipe-extraction job — no browser redirect needed.
//
// iOS doesn't let an HTTPS URL launch an installed PWA (Apple reserves that
// for Universal Links registered via the Apple Developer Program). So the
// Shortcut can't just `Open URLs` and have the PWA pick it up. Instead the
// Shortcut posts directly here, we kick off the same async pipeline used by
// /api/extract-video, and the user gets an iOS notification that the recipe
// was queued. The recipe shows up in their library as soon as the Inngest
// worker finishes — usually <30 seconds.
//
// Auth: `Authorization: Bearer <share key>` where the share key IS the user's
// Dropbox refresh token. They copy it out of Settings → Sharing once and
// paste it into the Shortcut. If they disconnect Dropbox the key is
// invalidated; they have to generate a new one.
//
// POST /api/share-from-shortcut
//   Headers: Authorization: Bearer <refresh-token>
//   Body:    { "url": "https://www.instagram.com/reel/..." }
//   Returns: 202 { jobId } | 4xx { error }

import { Inngest } from 'inngest';
import { dbxWriteJson, getCurrentAccount } from '../lib/dropbox.js';

const inngest = new Inngest({
  id: 'recipes-app',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'POST only' });
  }

  // ---- Auth: Bearer <share-key> ----
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(\S.*)$/i);
  if (!m) return json(res, 401, { error: 'missing share key' });
  const dbxToken = m[1].trim();
  if (!dbxToken) return json(res, 401, { error: 'empty share key' });

  // Validate the key by hitting Dropbox once. Cheap (we only need a 200 back).
  // If the token has been revoked we want to fail loudly here rather than
  // queueing a job that the worker would later reject.
  try {
    await getCurrentAccount(dbxToken);
  } catch (e) {
    return json(res, 401, { error: 'invalid or revoked share key' });
  }

  // ---- Body: { url } ----
  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { error: 'bad body' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'missing body' });

  // The Shortcut sends Shortcut Input, which on iOS for share-sheet URL
  // input arrives as a plain string. Strip whitespace and bail on anything
  // that doesn't look like a URL.
  const url = (body.url || '').toString().trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return json(res, 400, { error: 'missing or invalid url' });
  }

  const analysis = ['auto', 'audio', 'audio_frames', 'gemini'].includes(body.analysis)
    ? body.analysis
    : 'auto';

  // ---- Queue the job ----
  const jobId = newId();
  const now   = new Date().toISOString();
  const job = {
    id: jobId,
    status: 'pending',
    url,
    analysis,
    progress: 'Queued from Shortcut',
    source: 'shortcut',
    createdAt: now,
    updatedAt: now,
  };

  try {
    await dbxWriteJson(dbxToken, `/jobs/job-${jobId}.json`, job);
  } catch (e) {
    console.error('[share-from-shortcut] could not write job record:', e);
    return json(res, 500, { error: 'could not queue job' });
  }

  try {
    await inngest.send({
      name: 'recipes/video.extract',
      data: { jobId, url, analysis, frames: [], dbxToken },
    });
  } catch (e) {
    console.error('[share-from-shortcut] inngest.send failed:', e);
    try {
      await dbxWriteJson(dbxToken, `/jobs/job-${jobId}.json`, {
        ...job,
        status: 'error',
        error: 'Could not dispatch worker job: ' + (e.message || 'unknown'),
        updatedAt: new Date().toISOString(),
      });
    } catch {}
    return json(res, 500, { error: 'could not dispatch job', jobId });
  }

  // 202 Accepted — the Shortcut typically just shows a notification on 2xx.
  return json(res, 202, { jobId, ok: true });
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}
