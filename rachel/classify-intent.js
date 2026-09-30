// Intent classifier: "classify with the LLM, act with code."
// Unambiguous shapes are classified by RULES first (ruleIntent, source 'rule') and never reach
// the LLM. Everything else: a small, constrained Sonnet call returning a fixed enum; on timeout
// or error it is retried once on Haiku. The deterministic state machine acts on the label; the
// main LLM never interprets these messages free-form.
// Real bug (Sep 28): the Sonnet call timed out in bursts (4s cap, ~1% of turns, 3 in a row in one
// smoke run) and returned 'other' — "add a Macallan 18" then went to the LLM, which showed the
// bottle and never added it. Rules cover ~30% of real traffic (measured on 4,128 logged turns).
const INTENTS = ['place_order','add_item','select_option','set_quantity','change_time',
  'change_instructions','change_contact','change_address','remove_item','show_basket','recommend',
  'build_package','confirm_yes','confirm_no','cancel','answer','other'];

const SYSTEM = `You classify a customer's message to a beverage-ordering assistant. Return ONLY raw JSON: {"intent":"<one of: ${INTENTS.join('|')}>","ref":"<product name or option number the message refers to, or empty>","qty":<integer or 0>,"confidence":<0-1>}.
Definitions: place_order = wants to check out/order now ("lets order","go ahead","I'll take it"). NOT "let's go with <a product>" — that is select_option/add_item unless it also says order/checkout. add_item = add a product to the basket. select_option = picks one of options the assistant just listed (a number or a restated name). set_quantity = a bare number/quantity answering "how many". change_time = change the delivery date/time. change_instructions = change driver/delivery notes. change_contact = change name, phone, or email. change_address = change the delivery address (street/city/zip) — NOT instructions. remove_item = remove/drop something. show_basket = see what's in the basket/estimate/total. recommend = asks for a suggestion/recommendation. build_package = event package with guests/budget/hours. confirm_yes / confirm_no = answering a yes/no question. cancel = stop/abandon. answer = the message is simply the ANSWER to the question the assistant just asked (a name when asked for a name, a phone number when asked for a phone, an email or 'same' when asked for an email, a date/time when asked for a delivery time, instructions or 'none' when asked for delivery instructions) — NOT a request to change anything. other = anything else (questions, chit-chat, product lookups by name).
ref must be words the customer actually wrote (or an option number they wrote). If the message names no product ("put it in the cart", "add it"), ref is empty — never fill it in from the assistant's message.
Use the context (what the assistant last asked, current step) to disambiguate. If the assistant just asked a direct question and the message plausibly answers it, the intent is 'answer' unless the message explicitly asks to CHANGE something already given. A bare number after "how many" is set_quantity; after a numbered list it is select_option.`;

// ── Rules ────────────────────────────────────────────────────────────────────────────────
// Conservative on purpose: a shape either clearly matches or returns null (-> the LLM).
// Measured agreement with the LLM's own labels on 4,128 logged turns (qa/unit/classify-rules.test.js
// keeps real examples): bare numbers and yes/no 100%; the disagreements on "add X" / "show my
// cart" were the LLM missing ("add a bottle of Veuve Clicquot" -> other).
const YES = /^(y|ya|yes|yep|yeah|yup|sure|ok|okay|correct|confirmed?|sounds good|looks good|perfect|go ahead|yes please|please do|that'?s (right|correct)|absolutely|definitely)[\s.!]*$/i;
const NO = /^(n|no|nope|nah|no thanks|no thank you|not now|not yet)[\s.!]*$/i;
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, a: 1, an: 1 };
// "add" objects that are not a product (notes, contact, time, pronouns) — the LLM decides those.
const NOT_PRODUCT = /^(to|it|that|this|them|those|one|some|more|another|same)\b|\b(note|instructions?|message|gift|card|tip|name|phone|email|address|time|date|delivery|something|anything|options?)\b/i;

function ruleIntent(message, ctx = {}) {
  const m = String(message || '').replace(/\*/g, '').trim();
  if (!m || m.length > 80 || /\n/.test(m)) return null;
  const k = ctx.lastKind || 'other';
  const bare = m.match(/^#?\s*(\d{1,3})\s*[.!]?$/);
  if (bare) {
    const n = parseInt(bare[1]);
    if (k === 'numbered_list' && n >= 1 && n <= 20) return { intent: 'select_option', ref: String(n), qty: 0, rule: 'bare-number-after-list' };
    if (k === 'how_many' && n >= 1) return { intent: 'set_quantity', ref: '', qty: n, rule: 'bare-number-after-how-many' };
    return null;
  }
  if (k === 'yes_no') {
    if (YES.test(m)) return { intent: 'confirm_yes', ref: '', qty: 0, rule: 'yes-after-yes-no' };
    if (NO.test(m)) return { intent: 'confirm_no', ref: '', qty: 0, rule: 'no-after-yes-no' };
  }
  if (/^(show|see|view|check)( me)? (my |the )?(basket|cart)[\s.!?]*$|^what'?s in my (basket|cart)[\s.!?]*$/i.test(m)) return { intent: 'show_basket', ref: '', qty: 0, rule: 'show-basket' };
  // "add a Macallan 18" / "add 2 bottles of Tito's" / "please add Whispering Angel" — ONE product.
  const add = m.match(/^(?:(?:please|pls|can you|could you|can i|i'?d like to|i want to)\s+)?add\s+(?:(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a|an)\s+)?(?:(?:bottles?|btls?|cases?|packs?|cans?)\s+(?:of\s+)?)?(?:the\s+)?(.+?)(?:\s+(?:to|in(?:to)?)\s+(?:my |the )?(?:basket|cart|order))?(?:\s+please)?[\s.!?]*$/i);
  if (add) {
    const ref = add[2].trim();
    // A quantity after the name ("Kim Crawford 2 bottles", "Tito's x3") -> the LLM reads it.
    if (NOT_PRODUCT.test(ref) || /\b\d+\s*(x|bottles?|btls?|cases?|packs?|cans?)\b|\bx\s*\d+\b/i.test(ref) || /[,;&]|\band\b|\bplus\b|\bor\b/i.test(ref) || !/[a-z]{3}/i.test(ref) || ref.split(/\s+/).length > 7) return null;
    const q = add[1] ? (NUM_WORDS[add[1].toLowerCase()] || parseInt(add[1])) : 0;
    return { intent: 'add_item', ref, qty: q > 1 ? q : 0, rule: 'add-one-product' };
  }
  return null;
}

// Words of an LLM-extracted ref that the customer actually wrote. Real bug (Sep 28 QA): "Put it in
// the cart" came back add_item with ref "Kendall-Jackson Vintner's Reserve Cabernet Sauvignon"
// (copied from Rachel's own list) and that product was added unasked. '' = ref not grounded.
const GROUND_FILLER = new Set(['the', 'please', 'bottle', 'bottles', 'wine', 'one', 'add', 'cart', 'basket', 'order', 'that', 'this', 'with', 'and', 'put']);
function groundedRef(ref, message) {
  const w = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !GROUND_FILLER.has(t));
  const mw = w(message);
  if (/^\s*#?\d{1,2}\s*$/.test(String(ref)) && new RegExp('\\b' + String(ref).trim().replace('#', '') + '\\b').test(message)) return String(ref).trim();
  return w(ref).filter(t => mw.some(x => x === t || (x.length >= 3 && t.startsWith(x)) || (t.length >= 3 && x.startsWith(t)))).join(' ');
}

// The first JSON object in a model reply. Real bug (Sep 29): Sonnet and Haiku both followed the
// JSON with a note ("Unexpected non-whitespace character after JSON"), the classifier failed and
// the turn went unrouted. Tries each closing brace from the first '{' until one parses.
function firstJson(txt) {
  const s = String(txt || ''), a = s.indexOf('{');
  if (a < 0) return JSON.parse(s);
  for (let b = s.indexOf('}', a); b >= 0; b = s.indexOf('}', b + 1)) {
    try { const o = JSON.parse(s.slice(a, b + 1)); if (b + 1 < s.trim().length) console.log('[classify] ignored text after the JSON: ' + JSON.stringify(s.slice(b + 1, b + 81))); return o; } catch (e) {}
  }
  return JSON.parse(s);
}

async function callClassifier(model, timeoutMs, user, key) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 400, system: SYSTEM, messages: [{ role: 'user', content: user }] })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.type || 'api_error');
    const txt = (d.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    return firstJson(txt);
  } finally { clearTimeout(t); }
}

async function classifyIntent(message, ctx = {}) {
  const rule = ruleIntent(message, ctx);
  if (rule) return { intent: rule.intent, ref: rule.ref, qty: rule.qty, confidence: 1, source: 'rule:' + rule.rule };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { intent: 'other', ref: '', qty: 0, confidence: 0, source: 'no-key' };
  const user = `Context: last assistant question kind = ${ctx.lastKind || 'none'}; order step = ${ctx.orderStep || 'none'}; basket items = ${ctx.basketSize || 0}.\nThe assistant's last message was: ${JSON.stringify(ctx.lastQuestion || '')}\nMessage: ${JSON.stringify(String(message || '').slice(0, 400))}`;
  const errs = [];
  for (const [model, ms, src] of [['claude-sonnet-4-6', 6000, 'llm'], ['claude-haiku-4-5-20251001', 4000, 'llm-retry']]) {
    try {
      const j = await callClassifier(model, ms, user, key);
      const intent = INTENTS.includes(j.intent) ? j.intent : 'other';
      return { intent, ref: String(j.ref || ''), qty: parseInt(j.qty) || 0, confidence: Math.max(0, Math.min(1, parseFloat(j.confidence) || 0)), source: src + (errs.length ? '(' + errs.join(',') + ')' : '') };
    } catch (e) { errs.push(model.split('-')[1] + ':' + (e.name === 'AbortError' ? 'timeout' : e.message)); }
  }
  return { intent: 'other', ref: '', qty: 0, confidence: 0, source: 'error:' + errs.join(',') };
}
module.exports = { firstJson, classifyIntent, ruleIntent, groundedRef, INTENTS };
