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
- Prefer alternatives commonly available at any grocery store.`;
  } else {
    prompt = `A user is shopping and can't find an ingredient. Suggest substitutes that genuinely work as a stand-in.

ITEM: "${itemName}${itemNote}"

Without recipe context, focus on the most common cooking uses of this ingredient and suggest substitutes that cover those uses. Reject suggestions that only share a vague category — e.g. "ginger" for "garlic" is not an answer just because both are aromatics.

Return ONLY a JSON object with no prose, no markdown fences:

{
  "alternatives": [
    { "name": "shallot",   "confidence": "high",   "why": "Roasts and sautés like garlic for similar mellow allium flavor" },
    { "name": "leek (white part)", "confidence": "medium", "why": "Milder and sweeter — works in soups and sautés, weaker in raw dressings" }
  ]
}

Rules:
- Return 0 to 5 alternatives — QUALITY OVER QUANTITY. If only one or two genuinely work, return only those. If nothing reasonable exists, return empty.
- Order by confidence: best fit first.
- "confidence": "high" (works in most uses) or "medium" (works in some uses with a note). Do NOT include "low"-confidence guesses.
- "name": short (1-3 words, lowercase).
- "why": ONE sentence on the SPECIFIC functional match and any trade-off.
- Don't suggest the same item with a different name (e.g. "EVOO" for "olive oil"). Be substantive.
- Prefer items commonly available at any grocery store.`;
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
    // Defense-in-depth: even though the prompt forbids it, drop any "low"-confidence
    // entries the model slips through. Unknown/missing confidence is treated as
    // acceptable (older response shapes / generic queries).
    const raw = Array.isArray(parsed.alternatives) ? parsed.alternatives : [];
    const alternatives = raw
      .filter(a => a && a.name)
      .filter(a => {
        const c = String(a.confidence || '').toLowerCase();
        return c !== 'low';
      })
      .slice(0, 5);
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
