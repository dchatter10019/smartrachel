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

module.exports = { latest, stripSignature };
