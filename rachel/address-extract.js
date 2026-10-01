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

// A mail client's hard wrap inside the street: "Deliver to 100\nFederal Street" / "100 Federal\nStreet". Joined
// with a space, not ", ". Real bug (Oct 1, nightly QA email): Gmail wrapped the line after "100", the address
// became "100, Federal Street, ..." and wasn't found — Rachel asked for an address the email already gave.
// A unit number at a line end ("Floor 6\nBoston", "#6\nBoston") is a real break and stays ", ".
const UNIT_WORD = /\b(?:floor|fl|suite|ste|apartment|apt|unit|room|rm|building|bldg|no)\.?\s*$/i;
const STREET_SUFFIX = /^(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|place|pl|court|ct|way|square|sq|parkway|pkwy|terrace|highway|hwy)\b/i;
function unwrap(t) {
  const lines = t.split('\n');
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trimEnd(), next = lines[i].trimStart();
    const streetNo = /(?:^|[^\w#])\d{1,6}$/.test(prev) && !UNIT_WORD.test(prev.replace(/\d+$/, '')) && /^[A-Z][a-z]/.test(next);
    const suffix = /\b\d{1,6}\s+[A-Za-z][A-Za-z' ]*$/.test(prev) && STREET_SUFFIX.test(next);
    out = (streetNo || suffix) ? out.trimEnd() + ' ' + next : out + '\n' + lines[i];
  }
  return out;
}

function findAddress(text) {
  // Lines joined with ", " — but a blank line (paragraph break) stays a hard stop.
  const t = unwrap(String(text || '').replace(/\r/g, '')).replace(/\n\s*\n/g, ' ¶ ').replace(/\s*\n\s*/g, ', ').replace(/,\s*,/g, ',');
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

// The address to echo and store after Google geocodes it, built from the geocoder's components.
// Real bug (Sep 29, Sean's email): formatted_address was "100 Federal Street, 100 Federal St #6, Boston,
// MA 02110" — Google puts a building name (the "premise" component) in front of the street, and turns
// "Floor 6" into "#6", which doesn't tell a driver it's a floor. So: street number + route, then the
// customer's own unit wording if they gave one (else Google's subpremise as "#6"), then city, state zip.
// components: Google address_components; typed: what the customer wrote. Returns null if incomplete.
const UNIT = /\b(?:(?:floor|fl\.?|suite|ste\.?|apartment|apt\.?|unit|room|rm\.?|building|bldg\.?)\s*#?\s*[A-Za-z0-9-]+|\d+(?:st|nd|rd|th)\s+floor|#\s*[A-Za-z0-9-]+)(?=\s*(?:,|$|\s))/i;
function formatGeocoded(components, typed) {
  const c = {};
  for (const x of (components || [])) for (const ty of (x.types || [])) if (!c[ty]) c[ty] = x.short_name;
  if (!c.street_number || !c.route || !c.postal_code) return null;
  const um = String(typed || '').match(UNIT);
  const unit = um ? um[0].replace(/\s+/g, ' ').trim() : (c.subpremise ? '#' + c.subpremise : '');
  const city = c.locality || c.sublocality || c.postal_town || c.neighborhood || '';
  return [c.street_number + ' ' + c.route, unit, city, ((c.administrative_area_level_1 || '') + ' ' + c.postal_code).trim()]
    .filter(Boolean).join(', ');
}

module.exports = { findAddress, formatGeocoded };
