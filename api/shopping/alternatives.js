// api/shopping/alternatives.js
//
// "Can't find this at the store — what else works?" endpoint.
// Suggests 0-5 substitutes for a shopping-list item. Recipe-aware when
// the item came from a recipe (suggestions tuned to that recipe's flavor
// profile / role of the ingredient); generic otherwise.
//
// Provider strategy (cost-first, quality-fallback):
//   1. Try Gemini Flash 2.0 — ~10-15× cheaper than Claude on text-only.
//   2. If Gemini errors, returns malformed JSON, or returns zero usable
//      alternatives, fall back to Claude Haiku for a second shot.
//   3. Each call records token usage in the __usage array on the response
//      so the client can track cost in dev-mode StatsSheet.
//
// POST /api/shopping/alternatives
// body:
//   { name: "olive oil", qty?: "...", note?: "...",
//     recipe?: { title, ingredientLines: [string] },
//     location?: { label: "Lisbon, Portugal", country: "Portugal" } }
// response: { alternatives: [{ name, confidence, why }, ...], __usage: [...] }

import { humanizeApiError } from '../../lib/recipe-extract.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_MODEL  = process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Auth check — alternatives doesn't touch storage directly, but still
  // requires the user to be connected.
  const token = req.headers['x-dropbox-token'] || req.headers['x-storage-token'] || '';
  if (!token) return json(res, 401, { error: 'no storage token' });

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  let body;
  try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
  if (!body || !body.name) return json(res, 400, { error: 'missing name' });

  if (!ANTHROPIC_KEY && !GEMINI_KEY) {
    return json(res, 500, { error: 'ANTHROPIC_API_KEY or GEMINI_API_KEY required for alternatives' });
  }

  const itemName = String(body.name).trim();
  const itemNote = body.note ? ` (${String(body.note).trim()})` : '';
  const recipe = body.recipe || null;

  // Optional location bias. We only ever receive a coarse label like "Lisbon,
  // Portugal" — never raw lat/lon — and pass it on to Claude so suggestions
  // skew toward what's stocked at neighborhood stores in that region.
  const locationLabel = body.location && typeof body.location === 'object'
    ? String(body.location.label || body.location.country || '').trim().slice(0, 120)
    : '';
  const locationBlock = locationLabel
    ? `\n\nSHOPPER LOCATION: ${locationLabel}\nWhen ranking and choosing alternatives, prefer items commonly stocked at neighborhood grocery stores in this region. If a culturally-local substitute is a closer functional match (e.g. crème fraîche for sour cream in France, queso fresco for ricotta in Mexico, kefir for buttermilk in much of Eastern Europe), favor it. Avoid suggesting items that would be hard to find there.`
    : '';

  let prompt;
  if (recipe && recipe.title) {
    const ingredientLines = Array.isArray(recipe.ingredientLines) ? recipe.ingredientLines.slice(0, 30) : [];
    prompt = `A user is shopping and can't find one of the ingredients. Suggest substitutes that ACTUALLY WORK in THIS specific recipe.

ITEM THEY CAN'T FIND: "${itemName}${itemNote}"

THE RECIPE:
Title: ${recipe.title}
Ingredient lines:
${ingredientLines.map(s => '  - ' + s).join('\n')}

Step 1 — figure out the FUNCTIONAL ROLE of this ingredient in THIS recipe. How is it prepped (grated, diced, blended, whole)? What does it contribute (starch/structure, binding, moisture, fat, acidity, sweetness, aromatic flavor, crunch, browning)? The prep matters: a recipe that GRATES potatoes for hashbrowns needs something that grates and crisps — cauliflower steams and falls apart, so it does NOT fit.

Step 2 — recognize when an ingredient has NO real substitute. Some ingredients are flavor-distinctive and effectively irreplaceable in their role: garlic, ginger, lemon, lime, vanilla, cilantro, basil, mint, fish sauce, miso, soy sauce, parmesan, feta, coconut milk, tahini. For these, swapping in a different fresh ingredient (garlic → shallot, ginger → galangal, cilantro → parsley) usually produces a noticeably different dish and should be avoided unless the recipe is forgiving. Instead prefer the SAME ingredient in a different form when the user can't find the fresh version:
  • garlic → garlic powder, granulated garlic, jarred minced garlic, frozen garlic cubes
  • fresh ginger → ground ginger, jarred ginger paste, frozen ginger cubes
  • fresh herbs → dried (with a smaller amount note), or freeze-dried/paste tubes
These count as "different forms" and are the correct answer when nothing else genuinely substitutes. They are NOT to be confused with the same item under a synonym (EVOO for olive oil) — those should still be skipped.

Step 3 — for non-distinctive ingredients (oils, fats, mild aromatics, vegetables-as-bulk, broths, generic flours, sugars), suggest substitutes whose role is genuinely CLOSE. Reject anything that just shares a vague category.

Examples of BAD reasoning to avoid:
  • garlic → shallot / onion / leek: alliums ≠ garlic; the sulfur-compound flavor is unique. Reach for garlic powder or jarred minced garlic instead.
  • garlic → garlic salt: same ingredient with added salt — not substantive.
  • ginger → cinnamon: warming spice ≠ ginger's pungent heat.
  • grated potato → cauliflower: doesn't grate or crisp the same way.
  • butter (for browning) → olive oil: different smoke point and flavor; only fine if recipe doesn't actually brown.
Examples of GOOD reasoning:
  • "Garlic powder — 1/4 tsp per clove. Loses the fresh punch but keeps the savory backbone."
  • "Jarred minced garlic — same flavor profile, just less sharp than fresh."
  • "Sweet potato grates and crisps like russet for hashbrowns, just sweeter."
  • "Celery root shreds finely and browns into crispy strands; flavor is earthier."

Return ONLY a JSON object with no prose, no markdown fences:

{
  "alternatives": [
    { "name": "garlic powder",       "confidence": "high",   "why": "Use ~1/4 tsp per clove. Loses the fresh punch but keeps the savory backbone" },
    { "name": "jarred minced garlic", "confidence": "high",   "why": "Same flavor profile as fresh, slightly less sharp; sub 1:1 by volume" }
  ]
}

Rules:
- Return 0 to 5 alternatives — QUALITY OVER QUANTITY. If only one good fit exists, return one. If nothing genuinely works, return an empty array. NEVER pad to hit a count.
- Order by confidence: best fit first.
- "confidence": "high" (close functional match, recipe still tastes right) or "medium" (works with a noticeable trade-off — name the trade-off in "why"). Do NOT include any "low"-confidence guesses; omit them entirely.
- "name": short, store-friendly (1-3 words, lowercase).
- "why": ONE sentence naming the SPECIFIC functional match (texture/prep/role) in THIS recipe — not just "similar flavor". Include rough conversion ratio when helpful (e.g. "1/4 tsp powder per clove").
- Same ingredient in a different FORM (powder, jarred, frozen, dried, paste) is allowed and often the right answer. Same ingredient under a SYNONYM (EVOO for olive oil, garlic salt for garlic) is NOT — skip those.
- Prefer alternatives commonly available at any grocery store.${locationBlock}`;
  } else {
    prompt = `A user is shopping and can't find an ingredient. Suggest substitutes that genuinely work as a stand-in.

ITEM: "${itemName}${itemNote}"

Without recipe context, focus on the most common cooking uses of this ingredient and suggest substitutes that cover those uses.

Some ingredients are flavor-distinctive and effectively irreplaceable (garlic, ginger, lemon/lime, vanilla, cilantro, basil, mint, fish sauce, miso, soy sauce, parmesan, feta, coconut milk, tahini). For these, prefer the SAME ingredient in a different form (powder, jarred, frozen, dried, paste) over a different fresh ingredient. Reject suggestions that only share a vague category — e.g. shallot/onion for garlic is not an answer just because both are alliums; ginger for garlic is not an answer just because both are aromatics.

Return ONLY a JSON object with no prose, no markdown fences:

{
  "alternatives": [
    { "name": "garlic powder",        "confidence": "high",   "why": "Use ~1/4 tsp per clove. Loses fresh punch, keeps savory backbone" },
    { "name": "jarred minced garlic", "confidence": "high",   "why": "Same flavor profile as fresh, slightly less sharp; sub 1:1 by volume" }
  ]
}

Rules:
- Return 0 to 5 alternatives — QUALITY OVER QUANTITY. If only one or two genuinely work, return only those. If nothing reasonable exists, return empty.
- Order by confidence: best fit first.
- "confidence": "high" (works in most uses) or "medium" (works in some uses with a note). Do NOT include "low"-confidence guesses.
- "name": short (1-3 words, lowercase).
- "why": ONE sentence on the SPECIFIC functional match and any trade-off.
- Same ingredient in a different FORM (powder, jarred, frozen, dried, paste) is allowed and often the right answer for distinctive ingredients. Same ingredient under a SYNONYM (EVOO for olive oil, garlic salt for garlic) is NOT — skip those.
- Prefer items commonly available at any grocery store.${locationBlock}`;
  }

  const usage = [];
  // 1) Gemini Flash first.
  if (GEMINI_KEY) {
    try {
      const r = await callGemini(prompt);
      usage.push(r.usage);
      if (r.alternatives.length > 0) {
        return json(res, 200, { alternatives: r.alternatives, __usage: usage, provider: 'gemini' });
      }
      // Gemini returned valid JSON but no usable alternatives — let Claude have a try.
      console.log('[alternatives] gemini returned 0 alternatives, falling through to claude');
    } catch (err) {
      console.warn('[alternatives] gemini failed, falling through to claude:', err.message);
    }
  }

  // 2) Claude fallback.
  if (!ANTHROPIC_KEY) {
    return json(res, 500, { error: 'Gemini failed and no Anthropic key configured for fallback', __usage: usage });
  }
  try {
    const r = await callClaude(prompt);
    usage.push(r.usage);
    return json(res, 200, { alternatives: r.alternatives, __usage: usage, provider: 'claude' });
  } catch (err) {
    console.error('[alternatives] claude fallback failed:', err);
    return json(res, 500, { error: err.message || 'internal error', __usage: usage });
  }
}

// Filter "low"-confidence guesses defensively even though the prompt forbids them.
function sanitizeAlternatives(parsed) {
  const raw = Array.isArray(parsed && parsed.alternatives) ? parsed.alternatives : [];
  return raw
    .filter(a => a && a.name)
    .filter(a => String(a.confidence || '').toLowerCase() !== 'low')
    .slice(0, 5);
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // responseMimeType + responseSchema would be ideal, but Gemini's
      // schema support is restrictive on nested objects. Asking for plain
      // JSON with the prompt (which already says "ONLY a JSON object") and
      // parsing defensively works fine for this small payload.
      generationConfig: { temperature: 0.4, maxOutputTokens: 800, responseMimeType: 'application/json' },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(humanizeApiError('Gemini', r.status, t));
  }
  const body = await r.json();
  const text = (body.candidates || [])
    .flatMap(c => (c.content && c.content.parts) || [])
    .map(p => p.text || '')
    .join('')
    .trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Gemini returned no JSON');
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { throw new Error('malformed JSON from Gemini'); }
  const um = body.usageMetadata || {};
  return {
    alternatives: sanitizeAlternatives(parsed),
    usage: {
      provider: 'gemini',
      model: GEMINI_MODEL,
      inputTokens: um.promptTokenCount || 0,
      outputTokens: um.candidatesTokenCount || 0,
      ts: Date.now(),
    },
  };
}

async function callClaude(prompt) {
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
    const t = await r.text();
    throw new Error(humanizeApiError('Anthropic', r.status, t));
  }
  const body = await r.json();
  const content = (body.content || []).map(c => c.text || '').join('').trim();
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude returned no JSON');
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { throw new Error('malformed JSON from Claude'); }
  const u = body.usage || {};
  return {
    alternatives: sanitizeAlternatives(parsed),
    usage: {
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      ts: Date.now(),
    },
  };
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
