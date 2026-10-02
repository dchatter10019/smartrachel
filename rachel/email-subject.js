// The client (company) an email subject names. Real miss (Oct 2, DC's "Goody alcohol order"): only "... - Client"
// subjects were read, so Rachel asked "What is the client or company name?" with the name in the subject.
//   "Drinks quote - Gen II Fund"  -> "Gen II Fund"      (after a separator)
//   "Goody alcohol order"         -> "Goody"            (before an order/request word)
//   "Bar order for Acme Corp"     -> "Acme Corp"        (after "for")
// Returns '' when the subject names no one (e.g. "Drinks order", "Quote request").
const ORDER_WORDS = '(?:alcohol|drinks?|beverages?|bar|wine|liquor|beer|booze|cocktails?|party|event|holiday|office|team)?\\s*(?:order|request|quote|proposal|estimate|needs|list|delivery)';
const GENERIC = /^(?:new|drinks?|beverages?|bar|alcohol|wine|liquor|beer|order|quote|proposal|request|estimate|event|party|our|my|the|a|an|urgent|updated|revised|final|re|fwd?|question)$/i;

function clientFromSubject(subject) {
  let s = String(subject || '').replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, '').replace(/[\[\]"]/g, '').trim();
  if (!s) return '';
  const clean = c => {
    c = String(c || '').replace(/[\s,;:.!?–—-]+$/, '').replace(/^[\s,;:–—-]+/, '').trim();
    const w = c.split(/\s+/).filter(Boolean);
    if (!w.length || w.length > 5 || w.every(x => GENERIC.test(x))) return '';
    return c;
  };
  let m = s.match(/\s[-–—|:]\s*([^-–—|:]{2,60})$/);
  if (m && clean(m[1])) return clean(m[1]);
  m = s.match(new RegExp('\\bfor\\s+(?:the\\s+)?([A-Z][\\w&\'.]*(?:\\s+[A-Z0-9][\\w&\'.]*){0,4})', ''));
  if (m && clean(m[1])) return clean(m[1]);
  m = s.match(new RegExp('^(.{2,40}?)\\s+' + ORDER_WORDS + '\\b', 'i'));
  if (m && /^[A-Z0-9]/.test(m[1]) && clean(m[1])) return clean(m[1]);
  return '';
}

module.exports = { clientFromSubject };
