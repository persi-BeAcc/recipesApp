// api/job-status.js
//
// Two responsibilities, one function (Vercel Hobby's 12-function cap):
//
//   GET /api/job-status?id=<jobId>   → single job record
//   GET /api/job-status              → { jobs: [...] } in-flight jobs from
//                                       the last 10 minutes
//
// Both paths require a storage token. Supports Dropbox and Google Drive.

import { getProvider, getToken, ops } from '../lib/storage.js';

const FRESH_WINDOW_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = getToken(req);
  if (!token) return json(res, 401, { error: 'no storage token' });

  const provider = getProvider(req);
  const { readJson, listFolder } = ops(provider);

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
      const job = await readJson(token, `/jobs/job-${rawId}.json`);
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
  let entries = [];
  try {
    entries = await listFolder(token, '/jobs');
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
      const job = await readJson(token, path);
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
