// api/extract-video.js
//
// Kicks off an async video extraction job. Returns immediately with a jobId.
// The actual work happens in the Inngest worker (api/inngest.js).
//
// Two ways to authenticate (Vercel Hobby 12-function cap forced consolidation):
//   • x-dropbox-token: <refresh-token>   ← the PWA does this normally
//   • Authorization: Bearer <token>      ← the iOS Shortcut share-flow does this
// Either is forwarded into the Inngest event payload as `dbxToken`.

import { Inngest } from 'inngest';
import { dbxWriteJson } from '../lib/dropbox.js';

const inngest = new Inngest({
  id: 'recipes-app',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Pick up the Dropbox token from either header. PWA → x-dropbox-token,
  // iOS Shortcut → Authorization: Bearer <token>.
  let dbxToken = req.headers['x-dropbox-token'] || '';
  if (!dbxToken) {
    const auth = req.headers['authorization'] || '';
    const m = auth.match(/^Bearer\s+(\S.*)$/i);
    if (m) dbxToken = m[1].trim();
  }
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'missing body' });

  const url = (body.url || '').toString().trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return json(res, 400, { error: 'missing or invalid url' });
  }

  const analysis = ['auto', 'audio', 'audio_frames', 'gemini'].includes(body.analysis)
    ? body.analysis
    : 'auto';

  // Optional preferred-language code. The worker uses it to translate the
  // recipe before saving when the source isn't already in this language.
  // We accept ISO-639-1 (2-letter) codes from a small allowlist; anything
  // else is silently ignored so a malformed client can't poison the job.
  const ALLOWED_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh'];
  const language = ALLOWED_LANGS.includes(body.language) ? body.language : '';

  const frames = Array.isArray(body.frames) ? body.frames.slice(0, 6) : [];

  // If the request came in via Bearer auth, tag the job as 'shortcut' so the
  // PWA's pending-jobs surface knows to label it as queued from outside.
  const fromShortcut = !req.headers['x-dropbox-token'] && /^bearer\s+/i.test(req.headers['authorization'] || '');

  const jobId  = newId();
  const now    = new Date().toISOString();
  const job = {
    id: jobId,
    status: 'pending',
    url,
    analysis,
    progress: fromShortcut ? 'Queued from Shortcut' : 'Queued',
    createdAt: now,
    updatedAt: now,
    ...(language ? { language } : {}),
    ...(fromShortcut ? { source: 'shortcut' } : {}),
  };

  try {
    await dbxWriteJson(dbxToken, `/jobs/job-${jobId}.json`, job);
  } catch (e) {
    console.error('[extract-video] could not write job record:', e);
    return json(res, 500, { error: 'could not queue job' });
  }

  try {
    await inngest.send({
      name: 'recipes/video.extract',
      data: { jobId, url, analysis, language, frames, dbxToken },
    });
  } catch (e) {
    console.error('[extract-video] inngest.send failed:', e);
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

  // 202 Accepted — both flows expect this.
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
