// api/shopping/alternatives.js
//
// "Can't find this at the store — what else works?" endpoint.
// Suggests 3-5 alternatives for a shopping-list item. Recipe-aware when
// the item came from a recipe (suggestions tuned to that recipe's flavor
// profile / role of the ingredient); generic otherwise.
//
// POST /api/shopping/alternatives
// body:
//   { name: "olive oil", qty?: "...", note?: "...",
//     recipe?: { title, ingredientLines: [string], purpose?: string } }
// response: { alternatives: [{ name, why }, ...] }

import { humanizeApiError } from '../../lib/recipe-extract.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dbxToken = req.headers['x-dropbox-token'];
  if (!dbxToken) return json(res, 401, { error: 'no Dropbox token' });

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  let body;
  try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
  if (!body || !body.name) return json(res, 400, { error: 'missing name' });

  if (!ANTHROPIC_KEY) {
    return json(res, 500, { error: 'ANTHROPIC_API_KEY required for alternatives' });
  }

  const itemName = String(body.name).trim();
  const itemNote = body.note ? ` (${String(body.note).trim()})` : '';
  const recipe = body.recipe || null;

  let prompt;
  if (recipe && recipe.title) {
    const ingredientLines = Array.isArray(recipe.ingredientLines) ? recipe.ingredientLines.slice(0, 30) : [];
    prompt = `A user is shopping and can't find one of the ingredients. Suggest 3-5 alternatives that would actually work in THIS specific recipe.

ITEM THEY CAN'T FIND: "${itemName}${itemNote}"

THE RECIPE:
Title: ${recipe.title}
Ingredient lines:
${ingredientLines.map(s => '  - ' + s).join('\n')}

Return ONLY a JSON object with no prose, no markdown fences:

{
  "alternatives": [
    { "name": "vegetable oil", "why": "Neutral fat, same role" },
    { "name": "avocado oil",   "why": "Comparable smoke point for searing" }
  ]
}

Rules:
- 3-5 alternatives, ordered best-fit first.
- "name": short, store-friendly (1-3 words, lowercase).
- "why": ONE sentence explaining WHY it works in THIS recipe specifically (mention texture, flavor, or how it's used).
- Prefer alternatives commonly available at any grocery store.
- Don't suggest the same item with a different brand. Be substantive.`;
  } else {
    prompt = `A user is shopping and can't find an ingredient. Suggest 3-5 generic alternatives.

ITEM: "${itemName}${itemNote}"

Return ONLY a JSON object with no prose, no markdown fences:

{
  "alternatives": [
    { "name": "vegetable oil", "why": "Neutral fat for cooking" },
    { "name": "avocado oil",   "why": "Higher smoke point for high-heat cooking" }
  ]
}

Rules:
- 3-5 alternatives, ordered most versatile first.
- "name": short (1-3 words, lowercase).
- "why": ONE sentence on the trade-off / when it works.
- Prefer alternatives commonly available at any grocery store.`;
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      return json(res, r.status, { error: humanizeApiError('Anthropic', r.status, err) });
    }
    const cBody = await r.json();
    const content = (cBody.content || []).map(c => c.text || '').join('').trim();
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return json(res, 500, { error: 'Claude returned no JSON' });
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return json(res, 500, { error: 'malformed JSON from Claude' }); }
    const alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives.slice(0, 6) : [];
    return json(res, 200, { alternatives });
  } catch (e) {
    console.error('[alternatives]', e);
    return json(res, 500, { error: e.message || 'internal error' });
  }
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return null; }
}
