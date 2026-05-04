// api/job-status.js
//
// Two responsibilities, one function (Vercel Hobby's 12-function cap):
//
//   GET /api/job-status?id=<jobId>   → single job record (existing flow,
//                                       polled while a video is extracting)
//   GET /api/job-status              → { jobs: [...] } in-flight jobs from
//                                       the last 10 minutes (used by the
//                                       PWA on boot to surface jobs queued
//                                       elsewhere — e.g. iOS Shortcut share)
//
// Both paths require x-dropbox-token.

import { dbxReadJson, dbxListFolder } from '../lib/dropbox.js';

const FRESH_WINDOW_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' });
  }

  const rawId = (req.query.id || '').toString().trim();

  // ---- Single-job lookup ----
  if (rawId) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawId)) {
      return json(res, 400, { error: 'bad id' });
    }
    try {
      const job = await dbxReadJson(dbxToken, `/jobs/job-${rawId}.json`);
      return json(res, 200, job);
    } catch (e) {
      if (String(e?.message || e).includes('not_found')) {
        return json(res, 404, { error: 'job not found' });
      }
      console.error('[job-status]', e);
      return json(res, 500, { error: e.message || 'internal error' });
    }
  }

  // ---- List in-flight jobs (no id) ----
  // Walks /jobs/, reads each record in parallel (capped concurrency), keeps
  // jobs that aren't done/error and were created in the freshness window.
  let entries = [];
  try {
    entries = await dbxListFolder(dbxToken, '/jobs');
  } catch (e) {
    if (String(e.message || '').includes('not_found')) return json(res, 200, { jobs: [] });
    console.error('[job-status:list] list_folder failed:', e);
    return json(res, 500, { error: e.message || 'list failed' });
  }

  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const jobFiles = (entries || [])
    .filter(e => e && /^job-.+\.json$/.test(e.name || ''))
    .map(e => `/jobs/${e.name}`);

  const results = await mapWithLimit(jobFiles, 6, async (path) => {
    try {
      const job = await dbxReadJson(dbxToken, path);
      if (!job || typeof job !== 'object') return null;
      if (job.status === 'done' || job.status === 'error') return null;
      const createdMs = job.createdAt ? Date.parse(job.createdAt) : 0;
      if (!createdMs || createdMs < cutoff) return null;
      return {
        id: job.id,
        status: job.status,
        progress: job.progress || '',
        url: job.url || '',
        source: job.source || '',
        createdAt: job.createdAt,
      };
    } catch {
      return null;
    }
  });

  const jobs = results
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return json(res, 200, { jobs });
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

async function mapWithLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) return;
      out[idx] = await fn(arr[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
