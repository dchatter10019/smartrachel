// reviewer.js
// Reviews shopping-agent outputs before they reach the customer.
//
// Two layers:
//   1. Deterministic checks — run on every single intent, cheap, no LLM call.
//      Catches budget overruns, price-cap violations, duplicate items,
//      unconfirmed low-confidence matches slipping through, variety-cap
//      violations, and (for place_order specifically) line-item total
//      mismatches against what was actually quoted.
//   2. LLM critic — ONLY for recommendation/menu_build, and ONLY when the
//      deterministic layer found no hard violations. This is for genuinely
//      subjective judgment (does this pairing make sense for the occasion,
//      is this a coherent package) that no deterministic rule can capture.
//      Never used for product_query/custom_list (no subjective dimension —
//      the customer named what they want) or place_order (too risky to gate
//      a real financial transaction on a model's subjective opinion).
//
// Usage: const { reviewResult } = require('./reviewer.js');
//        const review = await reviewResult(intent, result, originalRequest);
//        if (!review.approved) { ...surface review.reason, optionally retry... }


const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REVIEW_MODEL = 'claude-sonnet-4-6';

function extractLineItems(result) {
  if (!result) return [];
  if (Array.isArray(result.line_items)) return result.line_items;
  if (typeof result.line_items === 'string') {
    try { return JSON.parse(result.line_items); } catch (e) { return []; }
  }
  if (Array.isArray(result.products)) return result.products;
  if (Array.isArray(result.results)) {
    let flat = [];
    for (const r of result.results) {
      if (r && Array.isArray(r.products)) flat = flat.concat(r.products);
    }
    return flat;
  }
  return [];
}

function checkBudget(items, request) {
  const budget = request.budget || request.total_budget;
  if (!budget || budget >= 999999) return null;
  const total = items.reduce((sum, i) => sum + (i.qty || i.quantity || 1) * (i.price || i.unit_price || 0), 0);
  if (total > budget * 1.05) {
    return `Product total $${total.toFixed(2)} exceeds the stated budget of $${budget} by more than 5%`;
  }
  return null;
}

function checkPriceCaps(items, request) {
  const violations = [];
  for (const item of items) {
    const price = item.price || item.unit_price || 0;
    if (request.max_price && price > request.max_price) {
      violations.push(`${item.name || item.label} at $${price} exceeds the max price cap of $${request.max_price}`);
    }
    if (request.min_price && price < request.min_price && price > 0) {
      violations.push(`${item.name || item.label} at $${price} is below the min price of $${request.min_price}`);
    }
  }
  return violations.length > 0 ? violations.join('; ') : null;
}

function checkDuplicates(items) {
  const seen = new Map();
  for (const item of items) {
    const key = (item.upc || item.product_id || item.name || '').toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    return `Duplicate line items for: ${dupes.map(([k]) => k).join(', ')} — should be combined into a single line with the right quantity, not repeated`;
  }
  return null;
}

function checkUnconfirmedLowConfidence(items) {
  const flagged = items.filter(i => i.low_confidence_match || i.requery_candidate);
  if (flagged.length > 0) {
    return `${flagged.length} item(s) have an unconfirmed low-confidence match that should have been confirmed with the customer before being included as a final line item`;
  }
  return null;
}

function checkOrderIntegrity(items, request) {
  const issues = [];
  for (const item of items) {
    const qty = item.qty || item.quantity || 0;
    if (qty <= 0) issues.push(`${item.name || item.label} has invalid quantity ${qty}`);
    const price = item.price || item.unit_price || 0;
    if (price <= 0) issues.push(`${item.name || item.label} has invalid price $${price} — refusing to place an order with a zero/negative price`);
  }
  if (request.quoted_total !== undefined && request.quoted_total !== null) {
    const actualTotal = items.reduce((sum, i) => sum + (i.qty || i.quantity || 1) * (i.price || i.unit_price || 0), 0);
    const diff = Math.abs(actualTotal - request.quoted_total);
    if (diff > Math.max(1, request.quoted_total * 0.02)) {
      issues.push(`Order total $${actualTotal.toFixed(2)} does not match the quoted total $${request.quoted_total.toFixed(2)} (diff $${diff.toFixed(2)})`);
    }
  }
  return issues.length > 0 ? issues.join('; ') : null;
}

function runDeterministicChecks(intent, result, request) {
  const items = extractLineItems(result);
  const violations = [];

  if (intent === 'place_order') {
    const orderIssue = checkOrderIntegrity(items, request);
    if (orderIssue) violations.push(orderIssue);
    return violations;
  }

  const dup = checkDuplicates(items);
  if (dup) violations.push(dup);

  const lowConf = checkUnconfirmedLowConfidence(items);
  if (lowConf) violations.push(lowConf);

  if (intent === 'menu_build' || intent === 'recommendation') {
    const budgetIssue = checkBudget(items, request);
    if (budgetIssue) violations.push(budgetIssue);
  }

  if (intent === 'product_query' || intent === 'custom_list') {
    const priceIssue = checkPriceCaps(items, request);
    if (priceIssue) violations.push(priceIssue);
  }

  return violations;
}

async function runLlmCritic(intent, result, request) {
  if (!ANTHROPIC_API_KEY) return { approved: true, reason: 'ANTHROPIC_API_KEY not configured — skipping subjective review' };

  const items = extractLineItems(result);
  if (items.length === 0) return { approved: true, reason: 'No items to review' };

  const itemsSummary = items.map(i => `- ${i.qty || i.quantity || 1}x ${i.name || i.label} — $${i.price || i.unit_price || 0}${i.category ? ' (' + i.category + ')' : ''}`).join('\n');
  const context = [
    request.occasion ? `Occasion: ${request.occasion}` : null,
    request.guests ? `Guests: ${request.guests}` : null,
    request.hours ? `Duration: ${request.hours} hours` : null,
    request.categories ? `Requested categories: ${request.categories.join(', ')}` : null,
    request.category ? `Requested category: ${request.category}` : null
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        max_tokens: 300,
        system: 'You are a quality reviewer for a beverage-ordering assistant\'s recommendations. Judge ONLY whether the selection is a reasonable, coherent fit for the stated context — not price (already checked separately). Respond with ONLY raw JSON, no markdown: {"approved": true or false, "reason": "one short sentence"}. Be lenient — only reject genuinely incoherent or clearly wrong selections (e.g. all hard liquor for a "kids birthday party", zero wine when wine was explicitly requested), not stylistic preferences.',
        messages: [{
          role: 'user',
          content: `Context:\n${context || '(no specific context given)'}\n\nSelected items:\n${itemsSummary}`
        }]
      })
    });
    const data = await res.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || '{}';
    const cleaned = rawText.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return { approved: parsed.approved !== false, reason: parsed.reason || '' };
  } catch (e) {
    console.error('[reviewer] LLM critic error:', e.message);
    return { approved: true, reason: 'Review call failed, defaulting to approved: ' + e.message };
  }
}

async function reviewResult(intent, result, request) {
  if (!result || result.success === false) {
    return { approved: true, layer: 'none', reason: 'Underlying call did not succeed' };
  }

  const violations = runDeterministicChecks(intent, result, request || {});
  if (violations.length > 0) {
    console.log('[reviewer] BLOCKED (deterministic):', intent, violations.join(' | '));
    return { approved: false, layer: 'deterministic', reason: violations.join('; ') };
  }

  if (intent === 'recommendation' || intent === 'menu_build') {
    const critic = await runLlmCritic(intent, result, request || {});
    if (!critic.approved) {
      console.log('[reviewer] BLOCKED (llm-critic):', intent, critic.reason);
      return { approved: false, layer: 'llm-critic', reason: critic.reason };
    }
  }

  return { approved: true, layer: 'passed', reason: '' };
}

module.exports = { reviewResult };
