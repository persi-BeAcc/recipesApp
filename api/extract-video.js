// api/extract-video.js
//
// Kicks off an async video extraction job. Returns immediately with a jobId.
// The actual work happens in the Inngest worker (api/inngest.js).
//
// Request body:
//   { url: string, analysis?: 'auto' | 'audio' | 'audio_frames' | 'gemini', frames?: string[] }
//
// `frames` is an optional array of JPEG dataURLs extracted in the browser
// (used when analysis === 'audio_frames').
//
// Response: { jobId } on success, { error } on failure.

import { Inngest } from 'inngest';
import { dbxWriteJson } from '../lib/dropbox.js';

const PASSCODE = process.env.APP_PASSCODE;

const inngest = new Inngest({
  id: 'recipes-app',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const pass = req.headers['x-app-passcode'];
  if (!PASSCODE || pass !== PASSCODE) {
    return json(res, 401, { error: 'unauthorized' });
  }
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
    // Persist the job record so /api/job-status can read it back.
    await dbxWriteJson(`/jobs/job-${jobId}.json`, job);

    // Fire the Inngest event. Frames are inlined into the event payload.
    // Inngest accepts up to ~512KB events; 6 small JPEGs (~50KB each) fit.
    await inngest.send({
      name: 'recipes/video.extract',
      data: { jobId, url, analysis, frames },
    });

    return json(res, 202, { jobId });
  } catch (e) {
    console.error('[extract-video] kickoff failed:', e);
    return json(res, 500, { error: e.message || 'kickoff failed' });
  }
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
