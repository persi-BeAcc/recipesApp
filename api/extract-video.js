// api/extract-video.js
//
// Kicks off an async video extraction job. Returns immediately with a jobId.
// The actual work happens in the Inngest worker (api/inngest.js).
//
// Two ways to authenticate (Vercel Hobby 12-function cap forced consolidation):
//   • x-dropbox-token / x-storage-token  ← the PWA does this normally
//   • Authorization: Bearer <token>       ← the iOS Shortcut share-flow does this
// Token + provider are forwarded into the Inngest event payload.

import { Inngest } from 'inngest';
import { getProvider, getToken, ops } from '../lib/storage.js';

const inngest = new Inngest({
  id: 'recipes-app',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = getToken(req);
  if (!token) return json(res, 401, { error: 'no storage token' });

  const provider = getProvider(req);
  const { writeJson } = ops(provider);

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

  // If the request came in via Bearer auth, tag the job as 'shortcut'
  const fromShortcut = !req.headers['x-dropbox-token'] && !req.headers['x-storage-token']
    && /^bearer\s+/i.test(req.headers['authorization'] || '');

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
    await writeJson(token, `/jobs/job-${jobId}.json`, job);
  } catch (e) {
    console.error('[extract-video] could not write job record:', e);
    return json(res, 500, { error: 'could not queue job' });
  }

  try {
    await inngest.send({
      name: 'recipes/video.extract',
      // Include provider so the Inngest worker knows which backend to use
      data: { jobId, url, analysis, language, frames, dbxToken: token, storageProvider: provider },
    });
  } catch (e) {
    console.error('[extract-video] inngest.send failed:', e);
    try {
      await writeJson(token, `/jobs/job-${jobId}.json`, {
        ...job,
        status: 'error',
        error: 'Could not dispatch worker job: ' + (e.message || 'unknown'),
        updatedAt: new Date().toISOString(),
      });
    } catch {}
    return json(res, 500, { error: 'could not dispatch job', jobId });
  }

  // 202 Accepted
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
