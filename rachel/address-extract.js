// The delivery address inside a longer message (email body, first message held through the age gate).
// Real bug (Sep 29, Sean's email): "The delivery address is 100 Federal Street, Floor 6\r\nBoston, MA 02110"
// was read as "6\r\nBoston, MA 02110" — the pattern allowed no line break or unit ("Floor 6") inside an
// address, so it matched from the unit number, and Rachel replied "delivering to 6, Boston".
//
// findAddress(text) -> "100 Federal Street, Floor 6, Boston, MA 02110" | null
//   - line breaks inside the address become ", "
//   - unit parts (Floor 6, Suite 200, Apt 4B, #12) are kept
//   - never spans a sentence break ("I am 21 years old. The delivery address is 100 ...")
//   - a match right after "address is" / "deliver to" wins over an earlier one

const CUE = /\b(?:delivery address|address|deliver(?:ed|y)?\s+(?:to|at)|ship(?:ped)?\s+to|send (?:it )?to)\b(?:\s+is)?\s*:?\s*$/i;

function findAddress(text) {
  // Lines joined with ", " — but a blank line (paragraph break) stays a hard stop.
  const t = String(text || '').replace(/\r/g, '').replace(/\n\s*\n/g, ' ¶ ').replace(/\s*\n\s*/g, ', ').replace(/,\s*,/g, ',');
  const RE = /\b(\d{1,6}\s+[A-Za-z0-9'#\- ]{2,60}?(?:\.(?=[A-Za-z,\s])(?![\s][A-Z][a-z]+\s+[a-z]))?(?:,\s*[A-Za-z0-9.'#\- ]{1,40}?){1,4},?\s+\d{5}(?:-\d{4})?)\b/g;
  const found = [];
  let m;
  while ((m = RE.exec(t))) {
    const a = m[1].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
    // A sentence break inside = two sentences, not an address: retry from the next word.
    if (/[.!?]\s+[A-Z]/.test(a) || /¶/.test(a)) { RE.lastIndex = m.index + 1; continue; }
    found.push({ a, cue: CUE.test(t.slice(Math.max(0, m.index - 40), m.index)) });
  }
  if (!found.length) return null;
  return (found.find(f => f.cue) || found[0]).a;
}

module.exports = { findAddress };
