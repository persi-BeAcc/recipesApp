// api/extract-video.js
//
// Kicks off an async video extraction job. Returns immediately with a jobId.
// The actual work happens in the Inngest worker (api/inngest.js).
//
// Auth: per-user. Caller's `x-dropbox-token` is forwarded into the Inngest
// event payload so the worker can write recipes + archive videos into the
// caller's own Dropbox app folder.

import { Inngest } from 'inngest';
import { dbxWriteJson } from '../lib/dropbox.js';

const inngest = new Inngest({
  id: 'recipes-app',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
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

  const frames = Array.isArray(body.frames) ? body.frames.slice(0, 6) : [];

  const jobId  = newId();
  const now    = new Date().toISOString();
  const job = {
    id: jobId,
    status: 'pending',
    url,
    analysis,
    progress: 'Queued',
    createdAt: now,
    updatedAt: now,
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
      data: { jobId, url, analysis, frames, dbxToken },
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

  return json(res, 202, { jobId });
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
