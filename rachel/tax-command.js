// Tax and proposal-address commands, read in code (DC, Oct 5). Pure; server.js applies them for the session.
// read(msg) -> 'zero' | 'restore' | null
//   "the tax shouldbe 0", "Estimated tax (10%): $79.16 is 0", "no tax", "tax exempt", "remove the tax" -> 'zero'
//   "add the tax back", "charge tax", "tax should be 10%" -> 'restore'
// proposalAddress(msg) -> 'hide' | 'show' | null
//   "take out the deivery address from the propsal", "don't show the address on the pdf" -> 'hide'
function read(msg) {
  const t = String(msg || '');
  if (/\?\s*$/.test(t) && !/\b(can|could|please)\b/i.test(t)) return null;   // "is there tax?" is a question
  if (/\b(?:add|put|bring)\s+(?:the\s+)?(?:sales\s+)?tax\s+back\b|\b(?:charge|include|apply)\s+(?:the\s+)?(?:sales\s+)?tax\b|\btax\b[^.?!\n]{0,20}\bshould\s*be\s+(?:10|included|charged)/i.test(t)) return 'restore';
  if (/\b(?:sales\s+)?tax\b(?:[^.?!\n]|\.(?=\d)){0,40}?(?:\bshould\s*be|\bto|\bis|=|:|\bbe|\bas)\s*\$?\s*(?:0(?:\.0+)?|zero|none|nothing|exempt)\b(?!\s*\.?\s*\d)(?!\s*%)/i.test(t)
    || /\bno\s+(?:sales\s+)?tax\b|\btax[- ]?(?:exempt|free)\b|\b(?:remove|drop|take\s+out|take\s+off|waive|zero\s+out)\s+(?:the\s+)?(?:sales\s+)?tax\b/i.test(t)) return 'zero';
  return null;
}
function proposalAddress(msg) {
  const t = String(msg || '');
  const doc = '(?:pro?p\\w*|pdf|quote)';
  if (new RegExp('\\b(?:add|put|show|include)\\b[^.?!\\n]{0,25}\\baddress\\b[^.?!\\n]{0,25}\\bback\\b|\\b(?:add|put)\\s+(?:the\\s+)?(?:delivery\\s+)?address\\s+(?:back\\s+)?(?:on|in)(?:to)?\\s+(?:the\\s+)?' + doc, 'i').test(t)) return 'show';
  if (new RegExp('\\b(?:remove|take\\s+out|take\\s+off|drop|hide|leave\\s+(?:off|out)|delete)\\b[^.?!\\n]{0,40}\\baddress\\b[^.?!\\n]{0,40}\\b' + doc + '\\b'
    + '|\\b' + doc + '\\b[^.?!\\n]{0,30}\\b(?:without|no)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\b'
    + '|\\b(?:don\'?t|do\\s+not)\\s+(?:show|include|put)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\b'
    + '|\\b(?:take|leave|keep)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\s+(?:off|out)\\b', 'i').test(t)) return 'hide';
  return null;
}
module.exports = { read, proposalAddress };
