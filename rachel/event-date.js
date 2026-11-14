// The event date printed on a proposal, cleaned from what the customer typed. Real bug (Oct 1, Sean / Foodie For
// All): the answer to "What is the event date?" was "Oct 6th, thanks Rache" and the PDF printed exactly that; the
// LLM's regenerate then printed "October 6, 2025" (a year already past). A recognised date is printed as
// "October 6, 2026" with the year given, else the next upcoming one; a stated year that is already past by more
// than 30 days is moved to the next occurrence (logged by the caller). Anything else ("TBD", "the weekend of the
// 12th") is kept, minus a trailing sign-off ("thanks", "cheers", the agent's name).
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WD_RE = '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?';
const SIGNOFF = /(?:[\s,;.!-]*\b(?:thanks?(?:\s+you)?|thx|ty|cheers|best|regards|much appreciated|appreciate it|please|pls)\b(?:\s+\w+)?[\s,.!]*)+$/i;

function monthIndex(m) { const k = String(m).toLowerCase().replace(/\.$/, '').slice(0, 3); return MONTHS.findIndex(x => x.startsWith(k)); }

function build(mi, day, year, now) {
  if (mi < 0 || day < 1 || day > 31) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let y = year, moved = false;
  if (y == null) { y = today.getFullYear(); if (new Date(y, mi, day) < today) y++; }
  else {
    if (y < 100) y += 2000;
    if (new Date(y, mi, day) < new Date(today.getTime() - 30 * 864e5)) { y = today.getFullYear(); if (new Date(y, mi, day) < today) y++; moved = true; }
  }
  const d = new Date(y, mi, day);
  if (d.getMonth() !== mi) return null;   // Feb 30
  return { text: MONTHS[mi][0].toUpperCase() + MONTHS[mi].slice(1) + ' ' + day + ', ' + y, moved };
}

// -> { text, changed, moved, why }   text = what the PDF prints.
function normalizeEventDate(raw, now = new Date()) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return { text: '', changed: false };
  let m = s.match(new RegExp('\\b' + WD_RE + MON_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b', 'i'));
  let r = m && build(monthIndex(m[1]), +m[2], m[3] ? +m[3] : null, now);
  if (!r) {
    m = s.match(new RegExp('\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON_RE + '(?:,?\\s+(\\d{4}))?\\b', 'i'));
    r = m && build(monthIndex(m[2]), +m[1], m[3] ? +m[3] : null, now);
  }
  if (!r) {
    m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    r = m && build(+m[1] - 1, +m[2], m[3] ? +m[3] : null, now);
  }
  if (!r) {
    m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    r = m && build(+m[2] - 1, +m[3], +m[1], now);
  }
  if (!r) {
    // "this Sunday", "next Friday", "coming Saturday", "tomorrow", a bare "Sunday" (Nov 13, connector: "This Sunday" was
    // printed on the PDF as the event date). "this <day>" = the next one from today (today itself if it is that day);
    // "next <day>" = the one after this week's when today is earlier in the week than it, as people mean it.
    const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const rel = s.match(/^\W*(?:(this|next|coming|this coming|on)\s+)?(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b\W*$/i);
    const tm = /^\W*(today|tonight|tomorrow)\W*$/i.exec(s);
    let d = null;
    if (rel) {
      const wi = WD.findIndex(w => w.startsWith(rel[2].toLowerCase().slice(0, 3)));
      let add = (wi - today.getDay() + 7) % 7;
      if (rel[1] && /^next$/i.test(rel[1]) && (add === 0 || today.getDay() < wi)) add += 7;
      d = new Date(today.getTime() + add * 864e5);
    } else if (tm) d = new Date(today.getTime() + (/tomorrow/i.test(tm[1]) ? 1 : 0) * 864e5);
    if (d) r = { text: MONTHS[d.getMonth()][0].toUpperCase() + MONTHS[d.getMonth()].slice(1) + ' ' + d.getDate() + ', ' + d.getFullYear(), moved: false };
  }
  if (r) return { text: r.text, date: true, changed: r.text !== s, moved: r.moved, why: r.moved ? 'stated year already past — next occurrence' : (r.text !== s ? 'date read from ' + JSON.stringify(s) : '') };
  const t = s.replace(SIGNOFF, '').replace(/[\s,;]+$/, '').trim();
  return { text: t || s, date: false, changed: !!t && t !== s, moved: false, why: t !== s ? 'sign-off removed' : '' };
}

// A customer's change to the client or event date of a proposal they already have ("remove the 'thanks Rache'
// from the date", "change the date to Oct 7", "have the client be: Foodie For All"). -> { client?, date?, why } or
// null. Applied in code and the PDF regenerated (server.js); before Oct 1 this went to the LLM, which had no
// record of the in-code PDF and asked for the client and date again.
function parseProposalFieldEdit(msg, savedDate, now = new Date()) {
  const s = String(msg || '');
  const out = {};
  // Every client statement; the LAST one wins. Real bug (Oct 1, DC's Goody quote): DC pasted the PDF's wrong
  // "Billed To:\nGoody Dipanjan Chatterjee CEO |" and wrote "it should be just Goody" under it — the pasted
  // line was taken as the new client and the PDF regenerated with it again.
  const cands = [];
  const LABEL = /\b(?:client(?:\s+name)?|company(?:\s+name)?|bill(?:ed)?\s+to)\b[ \t]*(?:(?:should\s+(?:say|be)|to\s+be|be|is|as|to)[ \t]*[:=-]?|[:=-])\s*["“']?([^\n"”]+?)["”']?\s*(?:[.;!]|,\s*(?:and|event|date)|\n|$)/gi;
  let cm;
  while ((cm = LABEL.exec(s))) cands.push({ at: cm.index, v: cm[1] });
  // "it should be just Goody" — a correction of a client already named in the message
  if (cands.length || /\b(?:client|company|bill(?:ed)?\s+to)\b/i.test(s)) {
    const CORR = /\b(?:it|that|this|name|should)\s+(?:should\s+)?(?:just\s+)?(?:be|say|read)\s+(?:just|only|simply)\s+["“']?([^\n"”]+?)["”']?\s*(?:[.;!]|\n|$)/gi;
    while ((cm = CORR.exec(s))) cands.push({ at: cm.index, v: cm[1] });
  }
  cands.sort((a, b) => a.at - b.at);
  const last = cands.filter(x => !/^(?:changed?|updated?|the same|wrong|right)\b/i.test(x.v.trim())).pop();
  if (last) {
    const c = last.v.replace(SIGNOFF, '').trim();
    if (c && c.length <= 80) out.client = c;
  }
  if (/\b(?:event\s+)?dates?\b/i.test(s)) {
    const after = s.slice(s.search(/\b(?:event\s+)?dates?\b/i));
    const d = normalizeEventDate(after, now);
    if (d.date) out.date = d.text;
    // "remove X from the date" / "fix the date" = clean it up (still regenerated when it is already clean — the
    // customer asked for a new PDF); "remove the date" = no date on the PDF.
    else if (savedDate && (/\b(?:remove|delete|take\s+out|drop|strip|get\s+rid\s+of)\b[^\n]{0,60}?\bfrom\s+(?:the\s+)?(?:event\s+)?date\b/i.test(s) || /\b(?:fix|clean(?:\s+up)?|correct)\b[^\n]{0,20}?\b(?:event\s+)?date\b/i.test(s))) {
      out.date = normalizeEventDate(savedDate, now).text; out.why = 'cleaned the saved date ' + JSON.stringify(savedDate);
    } else if (/\b(?:remove|delete|drop|take\s+out|no)\s+(?:the\s+)?(?:event\s+)?date\b(?!\s*(?:from|of)\b)/i.test(s)) {
      out.date = ''; out.why = 'date removed';
    }
  }
  if (!out.client && out.date === undefined) return null;
  const isEdit = /\b(?:change|update|fix|correct|remove|delete|take\s+out|replace|set|make|have|switch|should\s+be|instead|wrong|resend|re-send|send\s+back|updated|new)\b|\b(?:client|date)\s*:/i.test(s);
  return isEdit ? out : null;
}

// The event date stated in a quote email, or ''. Real bug (Oct 1, QA email-quote-list): cta.DATE_RE matched "Sun" in
// "2 x Sun Cruiser Ice tea Variety pack" and every PDF of that quote said "Event Date(s): Sun". Item lines (a
// quantity first) are skipped; a weekday counts only as a full name after on/this/next/for ("on Saturday").
function findEventDateIn(text, now = new Date()) {
  // A forwarded email's header ("Date: Sat, Nov 14, 2026 at 2:09 AM", "On Sat, Nov 14 ... wrote:") is when it was SENT,
  // never the event. Real (Nov 13, DC forwarding Eterra Kitchen): both quotes were dated November 14 (the forward), not
  // "delivery on Tuesday, November 17" / "the requested delivery date is Thursday, November 19th".
  const lines = String(text || '').split(/\r?\n/).filter(l => !/^\s*(?:[-•*·]\s*)?\d+\s*(?:x\b|×|\s+[A-Za-z])/i.test(l)
    && !/^\s*\*?(?:date|sent|from|to|cc|bcc):\*?\s/i.test(l) && !/^\s*On\s.{6,80}\bwrote:\s*$/i.test(l));
  // A line that says what the date is for (delivery / event / party / needed) first; a wrapped "on *Tuesday,\nNovember 17*"
  // is read with the line before it.
  const CUE_D = /\b(?:deliver(?:y|ed)?|event|party|reception|dinner|lunch|needed|need(?:s)? (?:it|them)|date)\b/i;
  const tries = [];
  lines.forEach((l, i) => { const two = l + ' ' + (lines[i + 1] || ''); if (CUE_D.test(l)) tries.push(two); });
  for (const t of tries.concat(lines)) {
    if (!/\d/.test(t)) continue;
    const d = normalizeEventDate(t, now);
    if (d.date) return d.text;
  }
  const wd = lines.join('\n').match(/\b(?:on|this|next|for)\s+((?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i);
  return wd ? wd[1][0].toUpperCase() + wd[1].slice(1).toLowerCase() : '';
}

// Every date a text states, one per line (same lines findEventDateIn reads: no item lines, no forward headers) -> [text].
function datesIn(text, now = new Date()) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(l => {
    if (!/\d/.test(l) || /^\s*(?:[-•*·]\s*)?\d+\s*(?:x\b|×|\s+[A-Za-z])/i.test(l) || /^\s*\*?(?:date|sent|from|to|cc|bcc):\*?\s/i.test(l) || /^\s*On\s.{6,80}\bwrote:\s*$/i.test(l)) return;
    const d = normalizeEventDate(l, now);
    if (d.date && !out.includes(d.text)) out.push(d.text);
  });
  return out;
}

// The client and event date given IN a proposal request ("please create a proposal for Liquid Labs, event date
// December 5"). -> { client?, date? } or null. Real bug (F-0034, Oct 13 QA): both were in the request and Rachel
// still asked "What is the client or company name?". A "for <X>" that is a pronoun, the items, a date, a number or
// an event word / weekday is not a client. "quote for" is not read: a quote names items ("a quote for Tito's").
const NOT_CLIENT = /^(?:the|a|an|me|us|my|our|this|that|these|those|it|them|him|her|you|your|all|everything|each|both|today|tomorrow|tonight|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|delivery|event|party|order|items?|drinks?|basket|cart|quote|proposal|pdf|guests?|people)\b/i;
function proposalRequestFields(msg, now = new Date()) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  const out = {};
  const m = s.match(/\b(?:proposal|pdf)\s+(?:for|to)\s+(?:client\s*:?\s*)?["“']?([A-Za-z][^,.;!?\n"”]{0,60}?)["”']?\s*(?:[,.;!?]|\s+(?:with|on|dated|event|for|and|by|please|thanks?)\b|$)/i);
  if (m) {
    const c = m[1].replace(SIGNOFF, '').trim();
    if (c && !NOT_CLIENT.test(c) && !new RegExp('^' + MON_RE + '(?:\\s|$)', 'i').test(c) && !/\d/.test(c)) out.client = c;
  }
  const d = normalizeEventDate(s, now);
  if (d.date) out.date = d.text;
  return out.client || out.date ? out : null;
}

module.exports = { normalizeEventDate, parseProposalFieldEdit, findEventDateIn, proposalRequestFields, datesIn };
