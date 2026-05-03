// api/job-status.js
//
// Polled by the client every ~2 seconds while a video extraction is running.
// Returns the current job record from the user's Dropbox.
//
// Request: GET /api/job-status?id=<jobId>   (with x-dropbox-token header)

import { dbxReadJson } from '../lib/dropbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' });
  }

  const id = (req.query.id || '').toString().trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return json(res, 400, { error: 'bad id' });
  }

  try {
    const job = await dbxReadJson(dbxToken, `/jobs/job-${id}.json`);
    return json(res, 200, job);
  } catch (e) {
    if (String(e?.message || e).includes('not_found')) {
      return json(res, 404, { error: 'job not found' });
    }
    console.error('[job-status]', e);
    return json(res, 500, { error: e.message || 'internal error' });
  }
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}
