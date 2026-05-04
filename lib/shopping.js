// lib/shopping.js
//
// Smart shopping-list helpers. The crown jewel is `processNewItems()`,
// which takes the user's existing list + a batch of new items (typed,
// photo-OCR'd, or pulled from a recipe) and asks Claude to:
//
//   1. Canonicalize each new item to a store-friendly NAME ("olive oil"
//      not "EVOO" or "extra virgin olive oil").
//   2. Dedupe against the existing list — treating synonyms as the same.
//   3. Decide whether to keep a quantity. Quantities are kept when the
//      source unit is something you'd buy AT THE STORE (cans, jars,
//      packages, lb, oz, kg, dozen, OR raw count of whole items like
//      onions / eggs / lemons). Cooking-portion units (tbsp, tsp, cup,
//      tiny gram amounts of spices) get dropped.
//   4. Sum compatible quantities on merges. "2 cans" + "1 can" = "3 cans".
//   5. Tag each new item with a coarse category: produce, dairy, meat,
//      seafood, bakery, pantry, frozen, beverages, other.
//
// The image-input variant uses the same prompt but feeds in image bytes
// instead of (or alongside) text items — Claude vision OCRs the photo
// and applies the same rules.

import { humanizeApiError } from './recipe-extract.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const PROMPT_RULES = `Rules:
- "name": canonical SHOPPING name. Lowercase, singular. No brand, no quantity, no measurement words. Treat synonyms as the same:
  EVOO == olive oil; scallions == green onions; cilantro == coriander leaves; courgette == zucchini.
- "qty": include ONLY when the source unit is something you'd buy at a grocery store:
    KEEP units: cans, jars, bottles, packages, boxes, bags, loaves, dozen, lb, oz, kg, g (when >100g), ml/L (when >250ml), or a raw count of whole items (onions, eggs, lemons, apples, peppers).
    DROP units: tbsp, tsp, cup, fl oz, pinch, small gram amounts of spices/herbs (e.g. "1 tsp salt", "1/2 cup flour" → no qty, just "salt"/"flour").
- When the source line includes a SECONDARY weight/volume that helps pick the right product at the store, KEEP it in qty:
    "1 can (400g) diced tomatoes"     → qty "1 can (400g)"
    "1 bag (200g) baby spinach"       → qty "1 bag (200g)"
    "2 cans (14 oz each) tomatoes"    → qty "2 × 14 oz cans"
    "1 jar (16 oz) marinara"          → qty "1 jar (16 oz)"
  But if the secondary number isn't useful for shopping (e.g. "3 garlic cloves (about 10g)" — you buy a head, not cloves), drop it and just use no qty.
- "category": one of: produce, dairy, meat, seafood, bakery, pantry, frozen, beverages, other.
- For "merge": sum compatible units only. "2 cans" + "1 can" = "3 cans". "1 lb" + "1/2 lb" = "1.5 lb". Different unit families → "skip" instead.
- "skip" is also correct when the same item is already on the list and the new addition wouldn't change the qty.
- Never invent items not present in the input.`;

// ---------------------------------------------------------------------------
// Public: process typed/recipe items.
//   existing: [{ name, qty?, category, ... }, ...]
//   newItems: ["2 cans diced tomatoes", "olive oil", ...]  (free-form strings)
//   returns: { updates: [{action, name, qty?, note?, category, reason?}, ...] }
// ---------------------------------------------------------------------------

export async function processNewItems({ existing, newItems }) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY required for shopping list');
  if (!Array.isArray(newItems) || newItems.length === 0) return { updates: [] };

  const existingSummary = (existing || []).map(it => ({
    name: it.name,
    ...(it.qty ? { qty: it.qty } : {}),
  }));

  const prompt = `You're maintaining a smart shopping list. Decide what to do with each new item.

EXISTING LIST (JSON):
${JSON.stringify(existingSummary, null, 2)}

NEW ITEMS BEING ADDED (one per line, raw):
${newItems.map(s => '- ' + s).join('\n')}

Return ONLY a JSON object with no prose, no markdown fences, in this shape:

{
  "updates": [
    { "action": "add",   "name": "ground beef", "qty": "1 lb", "category": "meat" },
    { "action": "merge", "name": "diced tomatoes", "qty": "3 cans", "category": "pantry" },
    { "action": "skip",  "reason": "olive oil already on list" }
  ]
}

One element in "updates" per NEW item, in order. Choose action per item:
- "add"   — not on the existing list. Include name + (optional) qty + category.
- "merge" — already on the existing list AND the qty grew. Include the FULL new combined qty.
- "skip"  — already on the list and qty doesn't change (or no qty either side).

${PROMPT_RULES}`;

  return callClaude(prompt);
}

// ---------------------------------------------------------------------------
// Public: process a photo of a shopping list (handwritten OR printed).
//   existing: same as above
//   imageBase64: raw base64 (no data: prefix) of a JPEG/PNG image
//   mimeType: 'image/jpeg' | 'image/png' | etc.
// ---------------------------------------------------------------------------

export async function processPhoto({ existing, imageBase64, mimeType = 'image/jpeg' }) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY required for shopping list');

  const existingSummary = (existing || []).map(it => ({
    name: it.name,
    ...(it.qty ? { qty: it.qty } : {}),
  }));

  const prompt = `Look at this image of a shopping list (handwritten or printed). Read every item, then decide what to do with each.

EXISTING SHOPPING LIST (JSON):
${JSON.stringify(existingSummary, null, 2)}

Return ONLY a JSON object with no prose, no markdown fences, in this shape:

{
  "updates": [
    { "action": "add",   "name": "ground beef", "qty": "1 lb", "category": "meat" },
    { "action": "merge", "name": "diced tomatoes", "qty": "3 cans", "category": "pantry" },
    { "action": "skip",  "reason": "olive oil already on list" }
  ]
}

One element in "updates" per item you can read in the image. Choose action per item:
- "add"   — not on the existing list.
- "merge" — already on list AND qty grew.
- "skip"  — already on list, qty unchanged.

${PROMPT_RULES}

If an item is illegible, omit it (don't guess).`;

  return callClaudeWithImage(prompt, imageBase64, mimeType);
}

// ---------------------------------------------------------------------------
// Apply a Claude-returned `updates` list to an existing shopping list.
// Pure function — given a current list and updates, returns the new list.
// ---------------------------------------------------------------------------

export function applyUpdates(existing, updates, { fromRecipe = null, now = new Date().toISOString() } = {}) {
  const items = [...(existing || [])];
  const byName = new Map(items.map(it => [normalizeName(it.name), it]));

  for (const u of (updates || [])) {
    if (!u || typeof u !== 'object' || !u.action) continue;
    const action = u.action;

    if (action === 'skip') continue;

    const name = String(u.name || '').trim().toLowerCase();
    if (!name) continue;
    const key = normalizeName(name);

    if (action === 'merge') {
      const existing = byName.get(key);
      if (existing) {
        if (u.qty) existing.qty = String(u.qty);
        if (u.category && !existing.category) existing.category = String(u.category);
        if (fromRecipe && !existing.fromRecipes?.includes(fromRecipe)) {
          existing.fromRecipes = [...(existing.fromRecipes || []), fromRecipe];
        }
      } else {
        // Edge case: Claude said merge but item isn't on the list. Treat as add.
        items.push(buildItem({ name, qty: u.qty, category: u.category, fromRecipe, now }));
        byName.set(key, items[items.length - 1]);
      }
      continue;
    }

    if (action === 'add') {
      // Defensive against double-add — if the name already exists (Claude
      // missed a synonym), upgrade to merge.
      const dup = byName.get(key);
      if (dup) {
        if (u.qty && !dup.qty) dup.qty = String(u.qty);
        if (fromRecipe && !dup.fromRecipes?.includes(fromRecipe)) {
          dup.fromRecipes = [...(dup.fromRecipes || []), fromRecipe];
        }
        continue;
      }
      items.push(buildItem({ name, qty: u.qty, category: u.category, fromRecipe, now }));
      byName.set(key, items[items.length - 1]);
    }
  }

  return items;
}

function buildItem({ name, qty, category, fromRecipe, now }) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name,
    ...(qty ? { qty: String(qty) } : {}),
    note: '',
    category: validCategory(category),
    checked: false,
    addedAt: now,
    ...(fromRecipe ? { fromRecipes: [fromRecipe] } : {}),
  };
}

function normalizeName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

const VALID_CATEGORIES = new Set(['produce', 'dairy', 'meat', 'seafood', 'bakery', 'pantry', 'frozen', 'beverages', 'other']);
function validCategory(c) {
  const x = String(c || '').toLowerCase().trim();
  return VALID_CATEGORIES.has(x) ? x : 'other';
}

// ---------------------------------------------------------------------------
// Claude callers (text-only and image)
// ---------------------------------------------------------------------------

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
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(humanizeApiError('Anthropic', r.status, err));
  }
  return parseUpdatesResponse(await r.json());
}

async function callClaudeWithImage(prompt, imageBase64, mimeType) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text',  text: prompt },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(humanizeApiError('Anthropic', r.status, err));
  }
  return parseUpdatesResponse(await r.json());
}

function parseUpdatesResponse(body) {
  const content = (body.content || []).map(c => c.text || '').join('').trim();
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude returned no JSON');
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { throw new Error('Claude returned malformed JSON'); }
  return {
    updates: Array.isArray(parsed.updates) ? parsed.updates : [],
  };
}
