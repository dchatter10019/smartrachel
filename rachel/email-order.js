// Placing an order from an EMAIL ("create the order", "send a payment link") — decided in code.
// DC (Sep 29): an email that asks to create/place the order or a payment link actually creates it and the
// reply carries the payment link. Contact = the CUSTOMER in the email (a forwarded customer's header and
// signature; the sender when the sender is the customer). Anything required that isn't in the email is asked
// for in ONE reply, never over several. Tip: 5% unless the email states one (DC).
//
// isOrderCommand(text) -> bool
// extract(text, sender) -> { name, email, phone, when, tip, instructions, source }
//   sender: { name, email }. A Bevvi sender (@getbevvi.com) is staff, never the customer.
// missing(od) -> [field labels]   askText(missing, od, problem) -> the single reply asking for them

const chrono = require('chrono-node');

const ORDER_CMD = /\b(?:(?:create|generate|send|make|set up|share|get)\b[^.?!\n]{0,40}?\bpay(?:ment)?\s*link|(?:place|create|submit|finali[sz]e|process|book|put (?:in|through))\s+(?:the|this|my|our|an?|that)?\s*(?:\w+\s+)?order|go ahead (?:and|with)(?: the)? (?:order|ordering|place it)|proceed with (?:the |this )?order)\b/i;
const NOT_YET = /\b(?:don'?t|do not|not yet|hold off|wait(?:ing)? (?:to|before|on)|before (?:you|we) (?:place|create))\b[^.?!\n]{0,40}\b(?:order|pay(?:ment)?\s*link)\b|\b(?:order|pay(?:ment)?\s*link)\b[^.?!\n]{0,20}\b(?:not yet|later|next week)\b/i;
function isOrderCommand(text) {
  const t = String(text || '').replace(/\s*\n\s*/g, ' ');
  return ORDER_CMD.test(t) && !NOT_YET.test(t);
}

const HEADER = /^\s*\*?(?:From|Date|Sent|Subject|To|Cc):\*?\s/i;
const FWD = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const isStaff = e => /@getbevvi\.com$/i.test(String(e || '').trim());
const fmtPhone = m => '(' + m[1] + ') ' + m[2] + '-' + m[3];

function splitForward(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const i = lines.findIndex(l => FWD.test(l));
  return i < 0 ? { top: lines, fwd: null } : { top: lines.slice(0, i), fwd: lines.slice(i + 1) };
}
// "From: Natalia Diaz <nd@x.com>" in a forwarded header block.
function fromHeader(lines) {
  for (const l of lines || []) {
    const m = l.match(/^\s*\*?From:\*?\s*"?([^"<\n]*?)"?\s*<([^>\s]+@[^>\s]+)>/i);
    if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
    if (!HEADER.test(l) && l.trim()) break;
  }
  return null;
}
// A phone in a block: a labelled line first (M:, Mobile, Phone, Tel, Cell), then any phone-shaped number.
function phoneIn(lines) {
  const body = (lines || []).filter(l => !HEADER.test(l));
  for (const l of body) if (/^\s*\*?(?:m|mobile|cell|phone|tel|telephone|ph|office|direct)\s*[:.]/i.test(l)) { const m = l.match(PHONE); if (m) return fmtPhone(m); }
  for (const l of body) { const m = l.match(PHONE); if (m && !/\b(?:order|invoice|po|zip|account|acct)\b/i.test(l)) return fmtPhone(m); }
  return '';
}
// Explicit fields the writer typed ("Name: ...", "Phone: ...", "Email: ...", "Contact: ...").
function field(lines, re) {
  for (const l of lines || []) { const m = l.match(re); if (m && m[1].trim()) return m[1].trim(); }
  return '';
}
// Delivery timing in the text (email header lines and quoted "On ... wrote:" lines skipped):
//   when: a date WITH a time ("Oct 5 at 2pm") | date: a date alone, after today ("Monday, October 5th")
//   time: a time alone ("2pm", "11am-12pm") — combined with a date given earlier.
// Real (Sep 29, Gen II): "note the delivery date is Monday, October 5th" was ignored (no hour) and Rachel
// re-asked for "the delivery date and time". "earlier today" is not a delivery date.
// Delivery-time wording chrono gets wrong, rewritten first (checked on real phrasings, Sep 29):
//   a range -> its START with a meridiem: "between 2 and 4pm" -> 2pm (chrono took 4pm), "12-2" -> 12pm (no
//   meridiem: no time at all), "11-1pm" -> 11am, "noon - 2pm" -> 12pm;
//   a bare hour -> delivery hours: "at 3" -> 3pm (chrono: 3 AM), "at 11" -> 11am;
//   "the 5th" -> the next 5th ("deliver on the 5th at 2pm" lost its date).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const merFor = h => ((h >= 1 && h <= 7) || h === 12 ? 'pm' : 'am');   // no am/pm given: business hours
const mer = x => (x ? (/^p/i.test(x) ? 'pm' : 'am') : '');
function normalizeTimes(text, now) {
  let t = String(text || '');
  t = t.replace(/(^|[^\d/:-])(between\s+|from\s+)?(noon|\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|and|until)\s*(noon|\d{1,2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d/-])/gi,
    (m, pre, bw, h1, mm, a1, h2, a2) => {
      if (!(a1 || a2 || bw || /noon/i.test(h1 + h2))) return m;   // "10-5" alone may be a date: left alone
      if (/noon/i.test(h1)) return pre + '12pm';
      const a = Number(h1), b = /noon/i.test(h2) ? 12 : Number(h2);
      if (a < 1 || a > 12 || b < 1 || b > 12) return m;
      const m1 = mer(a1) || (a2 ? (a <= b && a !== 12 ? mer(a2) : (a === 12 ? 'pm' : 'am')) : merFor(a));
      return pre + a + (mm ? ':' + mm : '') + m1;
    });
  t = t.replace(/\b(at|@)\s+(\d{1,2})(?::(\d{2}))?(?!\s*(?:am|pm|a\.m|p\.m|:|\d|\/|st\b|nd\b|rd\b|th\b|%|o'?clock))(?!\s+(?!(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))[A-Z][a-z])/g,
    (m, at, h, mm) => (Number(h) >= 1 && Number(h) <= 12 ? at + ' ' + h + (mm ? ':' + mm : '') + merFor(Number(h)) : m));
  const n = now || new Date();
  t = t.replace(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+of\b)/gi, (m, d) => {
    const day = Number(d); if (day < 1 || day > 31) return m;
    for (let k = 0; k < 3; k++) { const c = new Date(n.getFullYear(), n.getMonth() + k, day); if (c.getDate() === day && c > n) return MONTHS[c.getMonth()] + ' ' + day; }
    return m;
  });
  return t;
}
function timing(lines, now) {
  const n = now || new Date();
  const text = normalizeTimes((lines || []).filter(l => !HEADER.test(l) && !/^\s*On\s.+wrote:\s*$/.test(l)).join('\n'), n);
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime();
  const out = { when: '', date: '', time: '' };
  for (const r of chrono.parse(text, n, { forwardDate: true })) {
    const hasDay = r.start.isCertain('day') || r.start.isCertain('weekday'), hasHour = r.start.isCertain('hour');
    if (hasDay && hasHour) { if (!out.when) out.when = r.text; }
    else if (hasDay && !out.date && r.start.date().getTime() >= tomorrow) out.date = r.text;
    else if (hasHour && !hasDay && !out.time) out.time = r.text;
  }
  return out;
}
const findWhen = (lines, now) => timing(lines, now).when;
// Addresses the email asks to get the payment link ("send dipanjan@x.com a payment link", "send the link to a@b").
function linkRecipients(text) {
  const out = [];
  for (const sent of String(text || '').replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+/)) {
    if (!/\bpay(?:ment)?\s*link\b|\blink\b[^.]{0,20}\bpay/i.test(sent) || !/\b(?:send|email|forward|share)\b/i.test(sent)) continue;
    for (const m of sent.match(new RegExp(EMAIL.source, 'g')) || []) { const a = m.toLowerCase().replace(/[.,;:]+$/, ''); if (!/^rachelai@/.test(a) && !out.includes(a)) out.push(a); }
  }
  return out;
}
function tipIn(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  if (/\b(?:no tip|without (?:a )?tip|skip the tip|zero tip|0% tip|tip:? ?(?:0|zero|none))\b/.test(t)) return { pct: 0 };
  let m = t.match(/\btip\b[^.\n\d$]{0,20}(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)/) || t.match(/(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)\s*tip\b/);
  if (m) return { pct: Number(m[1]) };
  m = t.match(/\btip\b[^.\n\d$]{0,20}\$\s*(\d{1,4}(?:\.\d{1,2})?)/) || t.match(/\$\s*(\d{1,4}(?:\.\d{1,2})?)\s*tip\b/);
  if (m) return { amount: Number(m[1]) };
  return null;
}

function extract(text, sender, now) {
  const s = sender || {};
  const { top, fwd } = splitForward(text);
  const all = top.concat(fwd || []);
  const out = { name: '', email: '', phone: '', when: '', tip: tipIn(all.join('\n')), instructions: '', source: '' };
  // The customer: a forwarded customer, else the sender unless the sender is Bevvi staff.
  const fh = fwd ? fromHeader(fwd) : null;
  if (fh && !isStaff(fh.email)) { out.name = fh.name; out.email = fh.email; out.phone = phoneIn(fwd); out.source = 'forwarded customer'; }
  else if (!isStaff(s.email)) { out.name = String(s.name || '').trim(); out.email = String(s.email || '').toLowerCase(); out.phone = phoneIn(top); out.source = 'sender'; }
  // Typed fields win (either part of the email).
  const n = field(all, /^\s*\*?(?:name|contact(?: name)?|recipient|order (?:name|for))\*?\s*:\s*([^\n<]{3,60})$/i);
  if (n) { out.name = n.replace(PHONE, '').replace(EMAIL, '').replace(/[,;|]+\s*$/, '').trim(); out.source = out.source || 'typed'; }
  const em = field(all, /^\s*\*?(?:e-?mail|contact email|recipient email)\*?\s*:\s*(\S+@\S+)/i);
  if (em) out.email = em.replace(/[<>]/g, '').toLowerCase();
  const ph = field(all, /^\s*\*?(?:phone|mobile|cell|tel|contact (?:phone|number))\*?\s*[:.]\s*(.+)$/i);
  if (ph && PHONE.test(ph)) out.phone = fmtPhone(ph.match(PHONE));
  // A contact line in the new text ("Contact: Natalia Diaz, 555-010-0100, nd@x.com").
  const cl = field(top, /^\s*\*?contact\*?\s*:\s*(.+)$/i);
  if (cl) { if (PHONE.test(cl)) out.phone = fmtPhone(cl.match(PHONE)); if (EMAIL.test(cl)) out.email = cl.match(EMAIL)[0].toLowerCase(); }
  const tm = timing(all, now);
  out.when = tm.when; out.date = tm.date; out.time = tm.time;
  out.link_to = linkRecipients(top.join('\n'));
  out.instructions = field(all, /^\s*\*?(?:delivery |driver )?(?:instructions?|notes? for (?:the )?driver)\*?\s*:\s*(.+)$/i);
  return out;
}

const fullName = n => String(n || '').trim().split(/\s+/).filter(Boolean).length >= 2;
function missing(od) {
  const m = [];
  if (!fullName(od.name)) m.push("the customer's full name (first and last)");
  if (!od.email) m.push("the customer's email");
  if (!od.phone) m.push("the customer's phone number");
  if (!od.delivery_ok) m.push(od.delivery_date ? 'the delivery time on ' + (od.delivery_date_label || od.delivery_date) : 'the delivery date and time');
  return m;
}
function askText(miss, od, problem) {
  const have = [];
  if (fullName(od.name)) have.push('name: ' + od.name);
  if (od.email) have.push('email: ' + od.email);
  if (od.phone) have.push('phone: ' + od.phone);
  if (od.delivery_ok && od.delivery_label) have.push('delivery: ' + od.delivery_label);
  else if (od.delivery_date) have.push('delivery date: ' + (od.delivery_date_label || od.delivery_date));
  return "I'll create the order and send the payment link as soon as I have " + (miss.length > 1 ? miss.slice(0, -1).join(', ') + ' and ' + miss[miss.length - 1] : miss[0]) + '.' +
    (problem ? '\n\n' + problem : '') +
    (have.length ? '\n\nWhat I have so far — ' + have.join('; ') + '.' : '') +
    '\n\nPlease reply with ' + (miss.length > 1 ? 'all of these' : 'this') + ' in one email (e.g. "Natalia Diaz, 617-555-0100, natalia@company.com, Thursday Oct 1 at 2pm").';
}

module.exports = { isOrderCommand, extract, missing, askText, isStaff, tipIn, findWhen, timing, linkRecipients, normalizeTimes };
