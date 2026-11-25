// FACT READER — the model UNDERSTANDS the customer's wording, the code ENFORCES (DC, Nov 14: "are the wording being checked
// by the LLM and then interpreted? ... yes do that, but it should be more than just the bottle price"). Real misses the same
// day, all from wordings the code's patterns didn't know: "The wines should not BE more than $15" (Cloudy Bay $37 on the PDF),
// "48 bottles not 48 cases" (same PDF re-sent), "the requested delivery date is* Thursday, November 19th*".
//
// Nov 25 (DC: "can we move all the command parsing to LLM? ... lets make the changes"): this reader runs on EVERY message of real
// content and its reading comes first — bottle price, fees, the proposal client / date, drink rate, guests / hours, drink kinds,
// stock already on hand, brand choices, counted adds, complaint / proposal ask; the code validates and acts, the patterns below
// are the fallback when the model gives no reading, and every disagreement is recorded. (Before Nov 25:)
// The code's own readers stay first (bottle-price.js, tax-command.js, event-date.js, email-subject.js, address-extract.js,
// quote-edits.js): deterministic, tested, logged. This reader runs ONLY when a message plausibly states one of these facts
// (wants()), once per message text (memoized), with a small cached prompt. Where the code found nothing and the model did,
// the model's value is applied through the same code path and the miss is recorded (gap(): [fact-reader] + RACHEL_DATA_DIR/
// self-corrections.jsonl kind reader_gap -> monitor -> nightly fixer adds the wording to the code's reader). Where both found
// a value and they differ, the code's value stands and the disagreement is recorded.
//
// factsFor(text, { qa }) -> Promise<{ bottle_price?, event_date?, client?, delivery_address?, fees?, unit_corrections? } | null>

const fs = require('fs');
const MODEL = process.env.RACHEL_FACT_MODEL || 'claude-sonnet-4-6';

function system(today) {
  return `You read ONE message a customer sent to a beverage-ordering assistant and report the facts the message STATES. Omit every key the message does not state. Never guess, never infer from general knowledge, never fill in defaults.
Keys:
"bottle_price": {"category":"wine"|"spirits","max":number,"min":number} — a price limit or target PER BOTTLE ("the wines should not be more than $15" -> {"category":"wine","max":15,"min":0}; "around $20 a bottle" -> {"max":20,"min":12}; "keep the vodka under $30" -> {"category":"spirits","max":30,"min":0}). NOT a total budget, NOT per person, NOT per case.
"event_date": "Month D, YYYY" — the date of the event or of the delivery the customer states ("delivery date is Thursday, November 19th"). A date with no year = the next one on or after TODAY. Never an email's sent date (lines like "Date: ..." or "On ... wrote:").
"client": string — the client / company the order or proposal is FOR, only when the message names it as such ("the client is Acme", "this is for Goldman", "bill it to KPMG"). Never the sender's own name or signature.
"delivery_address": string — a street address to deliver to, as written (street, city, state, zip if given).
"fees": {"tax_percent":number,"tax_exempt":true,"service_percent":number,"tip_percent":number,"tip_amount":number,"delivery_fee":number} — ONLY fees the customer SETS or changes ("no tax", "service charge 8%", "tip $50", "free delivery" -> delivery_fee 0). Omit fees they only ask about.
"contact": {"name":string,"phone":string,"email":string} — the person the ORDER is for / the on-site or delivery contact, ONLY as the message gives them as such ("First and last Name: Diana Maranzano", "Contact: Jo Lee 212-555-0100", "on-site contact is Mara (862) 252-5077", "the email is x@y.com"). Never the sender's own signature block.
"unit_corrections": [{"product":string,"count":number,"unit":"bottles"|"cans"}] — ONLY a CORRECTION: the customer says a count means single bottles/cans and NOT cases/packs ("we need 48 bottles not 48 cases" -> [{"product":"beer","count":48,"unit":"bottles"}]). An ordinary order line ("Prosecco – 24 bottles") is never one.
"guests": number — the head count the message states ("1000 ppl", "for 80 people", "35-40 guests" -> 40).
"hours": number — how long the event runs ("2 hours", "4-7 pm" -> 3).
"drink_rate": {"per_person":number,"per_hour":boolean} — a drinks-per-person rate the customer states. A "consumption rate" or "N drinks per person" with no hour word is for the WHOLE event (per_hour false): "Your consumption rate was approx 1.5 drinks" -> {"per_person":1.5,"per_hour":false}. per_hour true ONLY when the customer says per hour / an hour / hourly.
"drink_types": ["wine"|"beer"|"seltzer"|"spirits"|"cocktails"|"non_alcoholic"|"mixers"] — the kinds of drinks the customer ASKS to serve or buy in this message. A brand counts as its kind: White Claw / High Noon / Truly = seltzer (never wine), Stella / Yuengling = beer. Stock they already HAVE is not asked for.
"on_hand": [{"name":string,"qty":number,"unit":string}] — products the customer says they (or their client) ALREADY HAVE and do not need to buy ("they already have 7 cases of White Claw + 15 cases of Yuengling" -> [{"name":"White Claw","qty":7,"unit":"cases"},{"name":"Yuengling","qty":15,"unit":"cases"}]).
"brand_choices": [{"type":string,"brands":[string],"qty":number,"size":string}] — ONE list line that offers a choice of brands for one product ("3 1L btls of Bourbon (Woodford / Makers Mark)" -> {"type":"Bourbon","brands":["Woodford","Makers Mark"],"qty":3,"size":"1L"}). The customer wants ONE of them (the first carried), never all.
"adds": [{"product":string,"qty":number,"unit":"bottles"|"cases"|"packs"|"cans"}] — products the customer asks to ADD with a count ("Add 25 bottles of Banshee Cabernet" -> [{"product":"Banshee Cabernet","qty":25,"unit":"bottles"}]). Not a full product list, not a swap.
"complaint": true — the customer says Rachel got something wrong or is unhappy ("you read wrong from the pdf", "that's not what I asked"). Omit otherwise.
"proposal_request": true — the customer asks Rachel to make / send / regenerate a proposal or PDF now. Omit when the message only mentions a proposal.
TODAY is ${today}. Answer by calling the facts tool once, with only the keys the message states (no keys when it states none).`;
}

// Does this message plausibly state one of the facts? (No call otherwise: "yes", "2", "place the order".)
const MONTHS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)\b/i;
// DC, Nov 25 ("can we move all the command parsing to LLM? ... lets make the changes"): every customer message of real content is
// read (not only ones the patterns flag) — a bare pick / yes / number keeps its deterministic path.
function wants(text) {
  const t = String(text || '');
  if (t.replace(/\s+/g, ' ').trim().length < 12) return false;
  if (!/^__/.test(t) && !/^[\d\s,.#&+-]*$/.test(t)) return true;
  return /\$\s?\d/.test(t) || MONTHS.test(t) || /\b(?:bucks|dollars|usd|percent|pct)\b|\d\s*%/i.test(t) || /\b\d{1,2}\/\d{1,2}\b/.test(t)
    || /\b(?:client|company|bill (?:it )?to|address|deliver(?:y|ed)? to|tax|tip|gratuity|service (?:charge|fee)|delivery (?:fee|charge))\b/i.test(t)
    || /\b(?:name|phone|contact|e-?mail|cell|mobile)\b/i.test(t) || /\d{3}\D{0,3}\d{3}\D?\d{4}/.test(t)
    || (/\b(?:bottles?|cans?)\b/i.test(t) && /\b(?:not|instead of|rather than)\b/i.test(t) && /\b(?:cases?|packs?)\b/i.test(t));
}

const num = { type: 'number' };
const TOOL = { name: 'facts', description: 'The facts the customer message states (omit what it does not state).', input_schema: { type: 'object', properties: {
  bottle_price: { type: 'object', properties: { category: { type: 'string', enum: ['wine', 'spirits'] }, max: num, min: num }, required: ['category', 'max'] },
  event_date: { type: 'string', description: 'Month D, YYYY' }, client: { type: 'string' }, delivery_address: { type: 'string' },
  fees: { type: 'object', properties: { tax_percent: num, tax_exempt: { type: 'boolean' }, service_percent: num, tip_percent: num, tip_amount: num, delivery_fee: num } },
  contact: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } },
  unit_corrections: { type: 'array', items: { type: 'object', properties: { product: { type: 'string' }, count: num, unit: { type: 'string', enum: ['bottles', 'cans'] } }, required: ['product', 'count', 'unit'] } },
  guests: num, hours: num,
  drink_rate: { type: 'object', properties: { per_person: num, per_hour: { type: 'boolean' } }, required: ['per_person', 'per_hour'] },
  drink_types: { type: 'array', items: { type: 'string', enum: ['wine', 'beer', 'seltzer', 'spirits', 'cocktails', 'non_alcoholic', 'mixers'] } },
  on_hand: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: num, unit: { type: 'string' } }, required: ['name'] } },
  brand_choices: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, brands: { type: 'array', items: { type: 'string' } }, qty: num, size: { type: 'string' } }, required: ['type', 'brands'] } },
  adds: { type: 'array', items: { type: 'object', properties: { product: { type: 'string' }, qty: num, unit: { type: 'string', enum: ['bottles', 'cases', 'packs', 'cans'] } }, required: ['product', 'qty'] } },
  complaint: { type: 'boolean' }, proposal_request: { type: 'boolean' } } } };
const memo = new Map();   // text -> { at, p }
async function callModel(text, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0, system: [{ type: 'text', text: system(today), cache_control: { type: 'ephemeral' } }],
        // One forced tool call = one structured answer (free text gave "{}" then "wait, let me reconsider" on "The wines
        // should not be more than $15").
        tools: [TOOL], tool_choice: { type: 'tool', name: 'facts' },
        messages: [{ role: 'user', content: 'Customer message:\n"""\n' + String(text).slice(0, 6000) + '\n"""' }] }),
    });
    const j = await r.json();
    if (!r.ok) { console.log('[fact-reader] model error ' + r.status + ': ' + JSON.stringify(j).slice(0, 160)); return null; }
    try { require('./ai-spend.js').record('fact-reader', MODEL, j.usage, { qa: opts && opts.qa }); } catch (e) {}
    const use = (j.content || []).find(c => c.type === 'tool_use' && c.name === 'facts');
    const facts = use && use.input;
    return facts && typeof facts === 'object' ? facts : null;
  } catch (e) {
    console.log('[fact-reader] no answer (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ') — the code\'s readers alone decide');
    return null;
  } finally { clearTimeout(timer); }
}
function factsFor(text, opts = {}) {
  const k = String(text || '').trim();
  if (!wants(k)) return Promise.resolve(null);
  const now = Date.now();
  for (const [kk, v] of memo) if (now - v.at > 15 * 60000) memo.delete(kk);
  if (!memo.has(k)) {
    const p = callModel(k, opts).then(f => { if (f && Object.keys(f).length) console.log('[fact-reader] ' + JSON.stringify(f).slice(0, 300)); return f; });
    memo.set(k, { at: now, p });
  }
  return memo.get(k).p;
}

// The model's fees in tax-command.js fees() shape (+ tax_exempt).
function feesShape(f) {
  if (!f || typeof f !== 'object') return null;
  const o = {};
  const n = v => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null));
  if (f.tax_exempt === true) o.tax_rate = 0;
  else if (n(f.tax_percent) != null) o.tax_rate = n(f.tax_percent) / 100;
  if (n(f.service_percent) != null) o.service_rate = n(f.service_percent) / 100;
  if (n(f.tip_amount) != null) o.tip_amount = n(f.tip_amount);
  else if (n(f.tip_percent) != null) o.tip_rate = n(f.tip_percent) / 100;
  if (n(f.delivery_fee) != null) o.delivery_fee = n(f.delivery_fee);
  return Object.keys(o).length ? o : null;
}
// The model's bottle price in bottle-price.js read() shape.
// A line that only carries a product's own price — a pasted basket / option line ("3x KJ Chardonnay — $15.74 ea = $47.22",
// "Gaffel Kölsch — 4x 16 OZ — $18.99"). Its price is never a per-bottle limit.
const PRICED_LINE = /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:ea|each|\/(?:bottle|btl|case|pack))\b|=\s*\$\s?\d|^\s*[•*\-]?\s*\d+\s*x\s|\s[—–-]\s*\$\s?\d[\d,]*(?:\.\d+)?\s*\**\s*$/i;
function bottleShape(b, said) {
  if (!b || typeof b !== 'object' || !(+b.max > 0)) return null;
  // Nov 21 (DC, Slack): a brief pasting "3x Le Grand Courtage ... — $23.09 ea" was read as "wine up to $23.09 a bottle" and
  // capped the build. A max that appears ONLY inside such lines is a product's price, not a limit.
  if (said) {
    const v = +b.max, hasV = t => (String(t).match(/\$\s?\d[\d,]*(?:\.\d+)?/g) || []).some(x => Math.abs(parseFloat(x.replace(/[$,\s]/g, '')) - v) < 0.005);
    const lines = String(said).split(/\n/), rest = lines.filter(l => !PRICED_LINE.test(l)).join('\n');
    if (lines.some(l => PRICED_LINE.test(l) && hasV(l)) && !hasV(rest)) { console.log('[fact-reader] bottle_price $' + v + ' NOT used — it is a pasted line\'s own price'); return null; }
  }
  return { category: b.category === 'spirits' ? 'spirits' : 'wine', max: +b.max, min: +b.min > 0 && +b.min < +b.max ? +b.min : 0, said: String(said || '').replace(/\s+/g, ' ').slice(0, 100), via: 'model' };
}

// The code missed (or disagreed with) what the model read: logged and recorded for the nightly fixer.
function gap(field, kind, codeVal, modelVal, ctx = {}) {
  console.log('[fact-reader] ' + (kind === 'missed' ? 'code MISSED ' + field + ' — using the model\'s reading: ' : 'code and model DISAGREE on ' + field + ' — code read ' + JSON.stringify(codeVal) + ', model read: ') + JSON.stringify(modelVal) + ' | ' + JSON.stringify(String(ctx.said || '').slice(0, 120)));
  try {
    const file = require('./data-dir.js').file('self-corrections.jsonl');
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), kind: 'reader_gap', gap: kind, session: ctx.session || '', channel: ctx.channel || '', qa: !!ctx.qa,
      customer_said: String(ctx.said || '').slice(0, 600), issues: [{ field, expected: modelVal, printed: codeVal == null ? null : codeVal, why: kind === 'missed' ? 'the code\'s reader found nothing; the model read it' : 'the code and the model read different values' }], corrected: kind === 'missed' ? ['model reading used'] : [] }) + '\n');
  } catch (e) {}
}

module.exports = { factsFor, wants, feesShape, bottleShape, gap, system };
