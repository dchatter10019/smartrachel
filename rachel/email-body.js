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

module.exports = { latest };
