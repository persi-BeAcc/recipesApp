// api/jobs-pending.js
//
// Returns any in-flight extraction jobs the user hasn't seen yet. The PWA
// calls this on boot so jobs queued from outside the app — for example via
// the iOS Shortcut share-sheet flow that posts to /api/share-from-shortcut —
// surface as a live progress sheet instead of silently completing in the
// background.
//
// We list /jobs/ folder, read each job record, keep the ones that aren't
// done/error and were created within the last 10 minutes (anything older
// is stale or orphaned). Sorted newest first.
//
// GET /api/jobs-pending
//   Headers: x-dropbox-token: <refresh-token>
//   Returns: { jobs: [{ id, status, progress, url, source, createdAt }, ...] }

import { dbxListFolder, dbxReadJson } from '../lib/dropbox.js';

const FRESH_WINDOW_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  let entries = [];
  try {
    entries = await dbxListFolder(dbxToken, '/jobs');
  } catch (e) {
    // Folder may not exist yet — that's fine, no jobs.
    if (String(e.message || '').includes('not_found')) return json(res, 200, { jobs: [] });
    console.error('[jobs-pending] list_folder failed:', e);
    return json(res, 500, { error: e.message || 'list failed' });
  }

  const cutoff = Date.now() - FRESH_WINDOW_MS;
  // Read jobs in parallel with a small concurrency cap so a slow Dropbox
  // doesn't blow up the response time on users with many old job records.
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
