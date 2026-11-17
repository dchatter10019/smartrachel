// ORDER READER — the model READS an email order, the code checks it and acts (DC, Nov 14: "we only use the llm for parsing ..
// and then it calls appropriate tools to make it more deterministic"). Same day, every email-order failure in DC's "Bevvi - Nov
// 14th Delivery" thread came from patterns: "Saturday 11/14" on Nov 14 = 2027, "Create the order now" booked 7 PM ET, the
// on-site contact / window one line under their labels in a colleague's forward, "First and last Name:" — and order
// BEVVI-AI-INFO-20261114-191806 went out for 7-8 PM with a garbled driver note.
//
// read(newEmail, { earlier, lastReply, sender, needs, today, qa }) -> ONE forced-tool Sonnet 4.6 call (RACHEL_ORDER_MODEL; 10s;
// memoized; ai-spend kind order-reader). It fills a fixed form and nothing else: intent, contact, on-site contact, delivery
// date / start time / zone, driver note, "X is not the customer" — every value with `from` (new | earlier email) and `quote`
// (the customer's exact words it came from). It never decides, converts dates, picks windows, writes replies or calls tools.
//
// check(reading, { newText, earlierTexts, staffNames }) -> { ok, intent, fields: {new: {...}, earlier: {...}}, rejected: [] }:
// a value whose quote is not in the email it names is dropped; names must be 2+ words and never a Bevvi forwarder; phone 10
// digits; email well-formed; a delivery date must read (chrono-today) as today or later; "now" / "asap" is never a time.
// server.js EMAIL ORDER then uses the checked values through the existing code (validateDeliveryTime against the store's real
// windows, EO.missing / askText, place_order, the replacement path). No reading = the patterns, as before.

const MODEL = process.env.RACHEL_ORDER_MODEL || 'claude-sonnet-4-6';

const SYSTEM = `You read an email a customer (or a colleague forwarding for one) sent to Rachel, a beverage-ordering assistant, about an order that is being set up, and you FILL IN A FORM. You do not reply, decide or act.
For every value give "from" ("new" = the new email, "earlier" = one of the earlier emails) and "quote" = the exact words of that email the value comes from (copied character for character, a short span). Copy values as written — never convert, compute or guess. Leave out anything the emails do not state.
Fields:
- intent: what the NEW email asks, from: "place_order" (create / place / book the order, send the payment link — including "yes, go ahead" to Rachel's offer to place it), "provide_details" (only gives details Rachel asked for), "confirm_yes" (only says yes / that's right to Rachel's last question), "none" (anything else). intent_quote = the words.
- contact: the CUSTOMER the order is for — name, email, phone ("First and last Name: Diana Maranzano", "Customer Name:\\nInge Pham", "the email is x@y.com"). Never the sender's signature when the sender is a colleague forwarding for someone.
- on_site: an on-site / delivery contact or point of contact — name, phone ("*On-Site Contact:*\\n\\nDiana Maranzano | 212-288-3500", "Main POC is Mara (862) 252-5077").
- delivery: date (as written: "Saturday 11/14", "tomorrow", "Nov 19"), start_time (the START of the time or window as written: "1-3pm" -> "1pm", "2:30 PM"), zone (as written: "ET", "Pacific"). "now", "asap", "today" alone as urgency, and an email's sent date ("Date: ...", "On ... wrote:") are NOT a delivery date or time.
- instructions: the driver's note only ("Deliver to the 3rd floor", "use the loading dock") — not contact names/phones, not item lists.
- not_customer: names the customer says are NOT the customer ("Mara is not the customer").
Answer by calling the order_form tool once.`;

const VAL = { type: 'object', properties: { value: { type: 'string' }, from: { type: 'string', enum: ['new', 'earlier'] }, quote: { type: 'string' } }, required: ['value', 'from', 'quote'] };
const TOOL = { name: 'order_form', description: 'The order details the emails state.', input_schema: { type: 'object', properties: {
  intent: { type: 'string', enum: ['place_order', 'provide_details', 'confirm_yes', 'none'] }, intent_quote: { type: 'string' },
  contact: { type: 'object', properties: { name: VAL, email: VAL, phone: VAL } },
  on_site: { type: 'object', properties: { name: VAL, phone: VAL } },
  delivery: { type: 'object', properties: { date: VAL, start_time: VAL, zone: VAL } },
  instructions: VAL,
  not_customer: { type: 'array', items: { type: 'string' } } }, required: ['intent'] } };

// The customer's words only: quoted history ("> ..."), "On ... wrote:" tails and forwarded copies of Rachel's own email go.
function customerOnly(t) {
  let x = String(t || '').replace(/\r/g, '');
  const cut = x.search(/^\s*On .{4,200}wrote:\s*$/m); if (cut > 0) x = x.slice(0, cut);
  x = x.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
  const rf = x.search(/^\s*From:.*rachelai@getbevvi\.com/im); if (rf >= 0) x = x.slice(0, rf);
  return x.trim();
}
function prompt(newText, o) {
  const earlier = (o.earlier || []).map(customerOnly).filter(Boolean).slice(-8);
  return 'TODAY: ' + o.today + '\nSENDER: ' + (o.sender || '') + '\nWHAT THE ORDER STILL NEEDS: ' + ((o.needs || []).join('; ') || 'nothing — it may be complete') + '\n\n'
    + 'RACHEL\'S LAST EMAIL (context only — never a source of values):\n"""\n' + String(o.lastReply || '(none)').slice(-1500) + '\n"""\n\n'
    + 'EARLIER EMAILS FROM THE CUSTOMER SIDE (oldest first):\n' + (earlier.length ? earlier.map((t, i) => '[earlier ' + (i + 1) + ']\n"""\n' + String(t).slice(0, 5000) + '\n"""').join('\n') : '(none)') + '\n\n'
    + 'NEW EMAIL:\n"""\n' + String(newText || '').slice(0, 6000) + '\n"""';
}

const memo = new Map();
async function callModel(user, o) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), o.timeoutMs || 10000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [TOOL], tool_choice: { type: 'tool', name: 'order_form' }, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) { console.log('[order-reader] model error ' + r.status + ': ' + JSON.stringify(j).slice(0, 160)); return null; }
    try { require('./ai-spend.js').record('order-reader', MODEL, j.usage, { qa: o.qa }); } catch (e) {}
    const use = (j.content || []).find(c => c.type === 'tool_use' && c.name === 'order_form');
    return use && use.input && typeof use.input === 'object' ? use.input : null;
  } catch (e) {
    console.log('[order-reader] no answer (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ') — the patterns decide');
    return null;
  } finally { clearTimeout(timer); }
}

function read(newText, o = {}) {
  const today = (o.now || new Date()).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const user = prompt(newText, Object.assign({}, o, { today }));
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at > 10 * 60000) memo.delete(k);
  if (!memo.has(user)) {
    const p = callModel(user, o).then(r => { if (r) console.log('[order-reader] read: ' + JSON.stringify(r).slice(0, 900)); return r; });
    memo.set(user, { at: now, p });
  }
  return memo.get(user).p;
}

// ── the code's checks ────────────────────────────────────────────────────────────────────────────────
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
const PHONE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i;
const NOT_TIME = /^(?:right\s+)?now$|^asap$|^immediately$|^today$|^tonight$|^soon$/i;

function check(rd, ctx = {}) {
  const out = { ok: false, intent: 'none', fields: { new: {}, earlier: {} }, rejected: [], notCustomer: [] };
  if (!rd || typeof rd !== 'object') return out;
  const newF = fold(customerOnly(ctx.newText)), earlierF = fold((ctx.earlierTexts || []).map(customerOnly).join('\n'));
  const rachelF = fold((ctx.rachelTexts || []).join('\n'));
  const staff = (ctx.staffNames || []).map(fold).filter(Boolean);
  const inSource = v => { if (!v || !v.quote) return false; const q = fold(v.quote); return q.length >= 2 && (v.from === 'earlier' ? earlierF.includes(q) || newF.includes(q) : newF.includes(q)); };
  const where = v => (v.from === 'earlier' && !newF.includes(fold(v.quote)) ? 'earlier' : 'new');
  const take = (field, v, test, norm) => {
    if (!v || !String(v.value || '').trim()) return;
    if (inSource(v) && rachelF && rachelF.includes(fold(v.quote)) && !fold(customerOnly(ctx.newText)).includes(fold(v.quote)) && fold(v.quote).length >= 6) { out.rejected.push(field + ': ' + JSON.stringify(v.quote) + ' is Rachel\'s own words, not the customer\'s'); return; }
    if (!inSource(v)) { out.rejected.push(field + ': ' + JSON.stringify(v.quote || '') + ' is not in the ' + (v.from === 'earlier' ? 'thread' : 'email')); return; }
    const val = String(v.value).trim();
    const why = test ? test(val, v) : '';
    if (why) { out.rejected.push(field + ': ' + JSON.stringify(val) + ' — ' + why); return; }
    out.fields[where(v)][field] = { value: norm ? norm(val) : val, quote: String(v.quote).trim() };
  };
  const nameTest = (n, v) => {
    if (/@|\d/.test(n)) return 'not a name';
    if (n.split(/\s+/).length < 2) return '';   // a first name alone is kept (the ask asks for the last name)
    if (staff.some(s => s === fold(n))) return 'a Bevvi colleague, never the customer';
    if (!fold(v.quote).includes(fold(n).split(' ')[0])) return 'the quote does not contain the name';
    return '';
  };
  const phoneTest = p => (PHONE.test(p) ? '' : 'not a phone number');
  const fmtPhone = p => { const m = p.match(PHONE); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : p; };
  const c = rd.contact || {}, s = rd.on_site || {}, d = rd.delivery || {};
  take('name', c.name, nameTest);
  take('email', c.email, e => (EMAIL.test(e.replace(/[<>]/g, '')) ? '' : 'not an email address'), e => e.replace(/[<>]/g, '').toLowerCase());
  take('phone', c.phone, phoneTest, fmtPhone);
  take('onsite_name', s.name, nameTest);
  take('onsite_phone', s.phone, phoneTest, fmtPhone);
  take('date', d.date, (v) => {
    if (NOT_TIME.test(v) && !/^today$/i.test(v)) return 'not a date';
    const CTD = require('./chrono-today.js');
    const r = CTD.parse(v, ctx.now || new Date(), { zone: ctx.zone })[0];
    if (!r && !/^(?:today|tomorrow)$/i.test(v)) return 'not a date the code can read';
    if (r) { const t0 = CTD.wallNow(ctx.zone, ctx.now || new Date()); t0.setHours(0, 0, 0, 0); if (r.start.date().getTime() < t0.getTime()) return 'before today'; }
    return '';
  });
  take('time', d.start_time, (v) => (NOT_TIME.test(v) ? '"' + v + '" is not a delivery time' : /\d/.test(v) || /\bnoon\b/i.test(v) ? '' : 'not a time'));
  take('zone', d.zone, (v) => (ctx.zoneOf && !ctx.zoneOf(v) ? 'not a time zone' : ''));
  take('instructions', rd.instructions, (v) => (v.length > 600 ? 'too long for a driver note' : PHONE.test(v) && v.replace(PHONE, '').trim().length < 8 ? 'only a phone number' : ''));
  // a time with no date in the new email: its own "today" / "tomorrow" (the model leaves "today" out — "today 2pm ET")
  if (out.fields.new.time && !out.fields.new.date) { const m = String(ctx.newText || '').match(/\b(today|tomorrow|tonight)\b/i); if (m) out.fields.new.date = { value: m[1].toLowerCase() === 'tonight' ? 'today' : m[1].toLowerCase(), quote: m[1] }; }
  out.notCustomer = (rd.not_customer || []).map(n => String(n || '').trim()).filter(n => n && newF.includes(fold(n)));
  // intent: the words must be in the NEW email
  const iq = fold(rd.intent_quote);
  out.intent = ['place_order', 'provide_details', 'confirm_yes'].includes(rd.intent) && (rd.intent === 'provide_details' || (iq && newF.includes(iq))) ? rd.intent : 'none';
  if (rd.intent && rd.intent !== 'none' && out.intent === 'none') out.rejected.push('intent ' + rd.intent + ': ' + JSON.stringify(rd.intent_quote || '') + ' is not in the email');
  out.ok = true;
  return out;
}

module.exports = { read, check, prompt, customerOnly, SYSTEM };
