// The part of an email Rachel should act on: the sender's new text, plus — when they forwarded something
// — the forwarded message itself. Everything older (quoted replies, earlier messages in the chain) is cut.
// Real case (Sep 29, Gen II Fund): Sean forwarded Natalia's edits; the body also carried the whole
// Monday/Tuesday history, including her ORIGINAL order list ("Allagash White 2 cases of 12 cans") and
// Sean's earlier replies. Fed whole, that history reads as new requests.
//
// latest(body) -> { text, trimmed: bool, forwarded: bool }

const FWD = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$/i;
const QUOTE_START = [
  /^\s*\*?From:\*?\s+\S/,                       // Outlook header block ("*From:* Sean ... *Sent:* ...")
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,                              // Outlook separator line
  /^\s*>/,                                       // "> quoted" lines
];
// "On Mon, Sep 28, 2026 at 4:24 PM Natalia Diaz <ndiaz@...> wrote:" — Gmail may wrap it over 2-3 lines.
function isOnWrote(lines, i) {
  if (!/^\s*On\s+\S/.test(lines[i])) return false;
  for (let k = 1; k <= 3 && i + k <= lines.length; k++) if (/wrote:\s*$/.test(lines.slice(i, i + k).join(' '))) return true;
  return false;
}
const isQuote = (lines, i) => QUOTE_START.some(r => r.test(lines[i])) || isOnWrote(lines, i);
const HEADER = /^\s*\*?(?:From|Date|Sent|Subject|To|Cc):\*?\s/i;

function latest(body) {
  const src = String(body || '');
  const lines = src.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length && !FWD.test(lines[i]) && !isQuote(lines, i)) i++;
  const top = lines.slice(0, i);
  if (i >= lines.length) return { text: src, trimmed: false, forwarded: false };
  if (!FWD.test(lines[i])) return { text: top.join('\n').trim(), trimmed: true, forwarded: false };
  // Forwarded: keep the marker, the forwarded message's header block, and its body up to the next quote.
  const fwd = [lines[i]];
  let j = i + 1;
  while (j < lines.length && (HEADER.test(lines[j]) || (!lines[j].trim() && j < i + 3))) fwd.push(lines[j++]);
  while (j < lines.length && !FWD.test(lines[j]) && !isQuote(lines, j)) fwd.push(lines[j++]);
  // A forwarded copy of RACHEL'S OWN email is history, never the customer's words. Real (Nov 13, DC): he forwarded her
  // reply back with "Price of wine cannot exceed $15"; its "Client: ... / Event date: ... / Options listed in the PDF /
  // regenerate the proposal" text was read as a new request and the same PDF came back with options, three times.
  if (fwd.some(l => /^\s*\*?From:\*?\s.*\brachelai@getbevvi\.com\b/i.test(l))) {
    const own = top.join('\n').trim();
    if (own) return { text: own, trimmed: true, forwarded: false, rachelForward: true };
  }
  const text = (top.join('\n').trim() + '\n\n' + fwd.join('\n').trim()).trim();
  return { text, trimmed: j < lines.length, forwarded: true };
}

// The sender's signature at the end of the new text. Real case (Oct 1, DC's Goody quote): every reply ended
// "Dipanjan Chatterjee / CEO | Bevvi / getbevvi.com | @getbevvi" — it became part of the client name on two
// PDFs ("Goody Dipanjan Chatterjee CEO |"), ~8 replies listed it as "I haven't done these yet", and picks
// ("Ketel one") were read as 4-part messages.
// Cut from: a "-- " marker; a line that is just the sender's name (from the From header) in the last
// lines; else a short trailing contact block (url / phone / "|" / @handle) after a blank-line gap.
// Never cuts the whole message.
// stripSignature(text, senderName) -> { text, cut: '' | the removed block }
const CONTACT = /(?:\b[a-z0-9-]+\.(?:com|io|co|net|org|ai)\b|https?:\/\/|\s\|\s|^\|| @\w|^@\w|\+?\d[\d\s().-]{8,}\d|^sent from my\b)/i;
function stripSignature(text, senderName) {
  const src = String(text || '');
  const lines = src.replace(/\r/g, '').split('\n');
  let end = lines.length; while (end > 0 && !lines[end - 1].trim()) end--;
  if (!end) return { text: src, cut: '' };
  let at = -1;
  // 1. "-- " signature marker
  for (let i = 1; i < end; i++) if (/^--\s*$/.test(lines[i])) { at = i; break; }
  // 2. the sender's name alone on a line, within the last 8 non-empty lines
  const nm = s => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = nm(senderName);
  if (at < 0 && name && name.split(' ').length >= 2) {
    let seen = 0;
    for (let i = end - 1; i > 0 && seen < 8; i--) {
      if (!lines[i].trim()) continue; seen++;
      if (nm(lines[i]) === name) { at = i; break; }
    }
  }
  // 3. no name: a trailing block of <= 5 short lines, after 2+ blank lines, with a contact line in it
  if (at < 0) {
    let i = end - 1, n = 0;
    while (i > 0 && n <= 6) {
      if (!lines[i].trim()) { if (!lines[i - 1].trim()) break; i--; continue; }
      n++; i--;
    }
    const start = i + 1, block = lines.slice(start, end).filter(l => l.trim());
    const gap = i > 0 && !lines[i].trim() && !lines[i - 1].trim();
    if (gap && block.length && block.length <= 5 && block.every(l => l.trim().length <= 60) && block.some(l => CONTACT.test(l.trim()))
        && !block.some(l => /\b\d+\s*(?:x|×)\s|\bbottles?\b|\bcases?\b|\bpacks?\b/i.test(l))) at = start;
  }
  if (at <= 0) return { text: src, cut: '' };
  const kept = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  if (!kept.trim()) return { text: src, cut: '' };
  return { text: kept, cut: lines.slice(at, end).join('\n').trim() };
}

// ── THE WHOLE EMAIL THREAD as context (DC, Nov 14: "the entire email exchanges should be always present, it's losing
// context"). Real case (Nov 13, HI USA NYC Hostel): DC forwarded Esthefany's "I forgot the delivery date" reply; her
// ORDER (Sauvignon Blanc 10 / Pinot Noir 6 / Prosecco 5, contact, window) sat in the quoted history below it, was cut by
// latest(), and Rachel asked "what beverages, how many guests?". latest() still decides what Rachel ACTS on; this keeps
// everything else in view, labeled as history, on every LLM turn of an email session.
// Per email: the conversation's FIRST email is kept whole (what it quotes/forwards happened before Rachel was copied);
// a later email = its new text + anything it forwards in full (outside content), never what it quotes (those emails are
// already in the thread) and never a forwarded copy of Rachel's own email. Rachel's emails = her reply text only.
const RACHEL_ADDR = /rachelai@getbevvi\.com/i;
const MAPS_LINE = /^[\s>]*<https?:\/\/(?:www\.)?google\.[a-z.]+\/maps\/[^>]*>\s*$/i;
function forContext(body, { first = false, fromRachel = false } = {}) {
  const lines = String(body || '').replace(/\r/g, '').split('\n').filter(l => !MAPS_LINE.test(l));
  let i = 0;
  while (i < lines.length && !FWD.test(lines[i]) && !isQuote(lines, i)) i++;
  const top = lines.slice(0, i).join('\n').trim();
  if (fromRachel) return top.replace(/\n+Warmly,\s*\n\s*Rachel[\s\S]*$/i, '').trim();
  if (first || i >= lines.length) return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!FWD.test(lines[i])) return top;
  const head = lines.slice(i, i + 8);
  if (head.some(l => /^\s*\*?From:\*?\s/i.test(l) && RACHEL_ADDR.test(l))) return top;   // Rachel's own email, forwarded back
  return (top + '\n\n' + lines.slice(i).join('\n')).replace(/\n{3,}/g, '\n\n').trim();
}

// emails: [{from, date, body}] oldest first, the CURRENT email last (current: true). -> the notes block ('' = nothing to
// add: a single email whose text Rachel already has in full). Long threads keep the first email and the newest ones.
const THREAD_MAX = 40000, FIRST_MAX = 15000;
function threadNote(emails, { currentText = '' } = {}) {
  const list = (emails || []).filter(e => e && String(e.body || '').trim());
  if (!list.length) return { note: '', count: 0, chars: 0, omitted: 0 };
  const parts = list.map((e, k) => {
    const fromRachel = RACHEL_ADDR.test(String(e.from || ''));
    let text = forContext(e.body, { first: k === 0 && !fromRachel, fromRachel });
    if (k === 0 && text.length > FIRST_MAX) text = text.slice(0, FIRST_MAX) + '\n[... rest of this email cut for length]';
    const who = fromRachel ? 'Rachel (you)' : String(e.from || 'customer').replace(/\s+/g, ' ').trim();
    return { head: '--- Email ' + (k + 1) + (e.current ? ' (THE EMAIL YOU ARE ANSWERING NOW)' : '') + ' — From: ' + who + (e.date ? ' — ' + String(e.date).trim() : ''), text };
  });
  // One email, nothing cut from it: the customer's message already carries all of it.
  if (parts.length === 1 && list[0].current && parts[0].text.replace(/\s+/g, ' ').trim() === String(currentText || '').replace(/\s+/g, ' ').trim()) return { note: '', count: 1, chars: 0, omitted: 0 };
  const size = p => p.head.length + p.text.length + 2;
  let keep = [parts[0]], budget = THREAD_MAX - size(parts[0]), tail = [];
  for (let k = parts.length - 1; k >= 1; k--) { if (size(parts[k]) > budget) break; tail.unshift(parts[k]); budget -= size(parts[k]); }
  const omitted = parts.length - 1 - tail.length;
  if (omitted) keep.push({ head: '--- [' + omitted + ' email(s) in between left out for length]', text: '' });
  keep = keep.concat(tail);
  const note = '## THE WHOLE EMAIL THREAD (every email so far, oldest first, with the history they quote or forward — the full context of this conversation). Use it for every fact the customer or their client already gave: items, quantities, sizes, price limits, dates, delivery address, contact, phone, delivery window, client name. Never ask for something this thread already says. The request to act on NOW is the customer\'s latest email (their message below); earlier requests here were already handled — do not redo them unless that email asks.\n'
    + keep.map(p => p.head + (p.text ? '\n' + p.text : '')).join('\n\n');
  return { note, count: parts.length, chars: note.length, omitted };
}

// The customer side of the thread for facts read IN CODE (dates, contact, client): every email not from Rachel, NEWEST
// first, as forContext gives it (the first email whole, later ones = new text + whole forwards), each with its own sent
// time so "tomorrow" / "this Sunday" in an older email are read from the day it was written. emails: as threadNote.
// DC, Nov 14: "all replies to the emails should remember the history" — the model saw the whole thread, but the replies
// written in code (in-code proposal, quote PDF, email order) read only the newest email + saved values (HI USA: the
// proposal said November 14, the thread said "the requested delivery date is Thursday, November 19th").
function customerEmails(emails) {
  const list = (emails || []).filter(e => e && String(e.body || '').trim());
  const out = [];
  list.forEach((e, k) => {
    if (RACHEL_ADDR.test(String(e.from || ''))) return;
    const text = forContext(e.body, { first: k === 0 });
    if (!text) return;
    const t = e.current ? new Date() : Number(e.ts) > 0 ? new Date(Number(e.ts)) : new Date(String(e.date || '').replace(/\s*\([A-Z]{2,5}\)\s*$/, ''));
    out.push({ text, sent: isNaN(t) ? new Date() : t, current: !!e.current });
  });
  return out.reverse();
}

module.exports = { latest, stripSignature, forContext, threadNote, customerEmails };
