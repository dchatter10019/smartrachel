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
  // "poposal" / "porposal" / "propsal" too (F-0290, Nov 19 DC: "poposal" missed the command, the model's PDF kept the address).
  const doc = '(?:pro?p\\w*|p[or]{1,3}p\\w*s\\w*|pdf|quote)';
  if (new RegExp('\\b(?:add|put|show|include)\\b[^.?!\\n]{0,25}\\baddress\\b[^.?!\\n]{0,25}\\bback\\b|\\b(?:add|put)\\s+(?:the\\s+)?(?:delivery\\s+)?address\\s+(?:back\\s+)?(?:on|in)(?:to)?\\s+(?:the\\s+)?' + doc, 'i').test(t)) return 'show';
  if (new RegExp('\\b(?:remove|take\\s+out|take\\s+off|drop|hide|leave\\s+(?:off|out)|delete)\\b[^.?!\\n]{0,40}\\baddress\\b[^.?!\\n]{0,40}\\b' + doc + '\\b'
    + '|\\b' + doc + '\\b[^.?!\\n]{0,30}\\b(?:without|no)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\b'
    // "No delivery address on proposal" (F-0290: told "I'm not able to suppress it")
    + '|\\b(?:without|no)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\s+(?:on|in)\\s+(?:the\\s+)?' + doc + '\\b'
    + '|\\b(?:don\'?t|do\\s+not)\\s+(?:show|include|put)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\b'
    + '|\\b(?:take|leave|keep)\\s+(?:the\\s+)?(?:\\w+\\s+)?address\\s+(?:off|out)\\b', 'i').test(t)) return 'hide';
  return null;
}
// Fees on the quote, set in words (DC, Oct 13 — Sean: "Adjust the tax to: 8.8875% / Adjust the tip to: $50 flat fee /
// Adjust the delivery to: $0"; the LLM wrote those numbers in its reply but the PDF kept 9% / 5% / $25).
// fees(msg) -> { tax_rate?, service_rate?, tip_rate?, tip_amount?, delivery_fee? } | null  (rates as fractions)
//   tax: a % ("tax to 8.8875%", "tax rate 8.875 percent"); service: a % or "no service charge"; tip: a % or a $ amount
//   ("tip $50 flat", "tip to 15%", "no tip"); delivery: a $ amount ("delivery to: $0", "delivery fee 0", "free delivery").
//   "delivery to 1460 Broadway" is an address, never a fee: a delivery number needs a "$" or a fee/charge word.
function fees(msg) {
  const t = String(msg || '').replace(/\r/g, '');
  if (/\?\s*$/.test(t) && !/\b(can|could|please|adjust|change|update|set|make)\b/i.test(t)) return null;
  const out = {};
  // The gap between a fee word and its value never crosses ANOTHER fee word or "free" (Nov 18, DC on Slack: "make the
  // delivery as free and make the tip to be $50" set delivery $50 — the tip's $50).
  const SET = '(?:(?!\\b(?:tip|gratuity|service|tax|free|delivery)\\b)[^.?!\\n$%\\d]){0,30}?(?:\\bto|\\bbe|\\bat|\\bof|\\bis|=|:|\\bas)?\\s*:?\\s*';
  const NUM = '(\\d+(?:\\.\\d+)?)';
  let m;
  // The number may come first too (Nov 11, DC on Claude Code: "create a porposal with a 8% service charge", "its 8% service
  // charge", "apply a 8% service charge" — none was read, and the PDF kept 10% three times).
  const PCT = '[ \\t]*(?:%|percent\\b|pct\\b)[ \\t]*';
  if ((m = t.match(new RegExp('\\b(?:sales\\s+)?tax(?:\\s+rate)?\\b' + SET + NUM + '\\s*(?:%|percent\\b|pct\\b)', 'i')))
    || (m = t.match(new RegExp('\\b' + NUM + PCT + '(?:sales\\s+)?tax\\b', 'i')))) out.tax_rate = parseFloat(m[1]) / 100;
  // A tax RATE with no % sign ("and the tax as 8.8875", "tax to 8.875"; F-0325, Nov 26 DC on Slack — only the model read it):
  // an explicit to/as/be/is/at/= before a number above 0 and up to 25 that ends the clause (no $, no further digits/words).
  else if ((m = t.match(new RegExp('\\b(?:sales\\s+)?tax(?:\\s+rate)?\\b' + '(?:(?!\\b(?:tip|gratuity|service|delivery)\\b)[^.?!\\n$%\\d]){0,30}?(?:\\bto|\\bbe|\\bas|\\bis|\\bat|=|:)\\s*' + NUM + '(?=\\s*(?:$|[,;!\\n]|\\.(?!\\d)|\\s+and\\b|\\s+please\\b))', 'i')))
    && parseFloat(m[1]) > 0 && parseFloat(m[1]) <= 25) { out.tax_rate = parseFloat(m[1]) / 100; console.log('[tax-command] tax ' + m[1] + ' with no % read as a rate'); }
  if ((m = t.match(new RegExp('\\bservice(?:\\s+(?:charge|fee))?\\b' + SET + NUM + '\\s*(?:%|percent\\b|pct\\b)', 'i')))
    || (m = t.match(new RegExp('\\b' + NUM + PCT + 'service(?:\\s+(?:charge|fee))?\\b', 'i')))) out.service_rate = parseFloat(m[1]) / 100;
  else if (/\b(?:no|remove|drop|waive|take\s+(?:out|off))\s+(?:the\s+)?service\s+(?:charge|fee)\b/i.test(t)) out.service_rate = 0;
  if ((m = t.match(new RegExp('\\b(?:tip|gratuity)\\b' + SET + '\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)', 'i')))) out.tip_amount = parseFloat(m[1].replace(/,/g, ''));
  else if ((m = t.match(new RegExp('\\$[ \\t]*(\\d[\\d,]*(?:\\.\\d+)?)[ \\t]*(?:flat[ \\t]+)?(?:tip|gratuity)\\b', 'i')))) out.tip_amount = parseFloat(m[1].replace(/,/g, ''));
  else if ((m = t.match(new RegExp('\\b(?:tip|gratuity)\\b' + SET + NUM + '\\s*(?:%|percent\\b|pct\\b)', 'i')))
    || (m = t.match(new RegExp('\\b' + NUM + PCT + '(?:tip|gratuity)\\b', 'i')))) out.tip_rate = parseFloat(m[1]) / 100;
  else if (/\b(?:no|remove|drop|waive|take\s+(?:out|off))\s+(?:the\s+)?(?:tip|gratuity)\b/i.test(t)) out.tip_rate = 0;
  if ((m = t.match(new RegExp('\\bdelivery(?:\\s+(?:fee|charge|cost))?\\b' + SET + '\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)', 'i')))) out.delivery_fee = parseFloat(m[1].replace(/,/g, ''));
  // The amount first: "Add $25 as delivery", "$25 for the delivery fee", "$15 delivery charge" (F-0325, Nov 25 DC on Slack).
  else if ((m = t.match(/\$[ \t]*(\d[\d,]*(?:\.\d+)?)[ \t]+(?:(?:as|for)[ \t]+(?:the[ \t]+|a[ \t]+)?delivery\b(?![ \t]+(?:on|to|at|by)\b)|delivery[ \t]+(?:fee|charge|cost)\b)/i))) out.delivery_fee = parseFloat(m[1].replace(/,/g, ''));
  else if ((m = t.match(new RegExp('\\bdelivery\\s+(?:fee|charge|cost)\\b' + SET + NUM + '\\b(?!\\s*%)', 'i')))) out.delivery_fee = parseFloat(m[1]);
  // A bare amount that ENDS the message ("make the delivery to 0", "make the delivery to be 0", "set delivery to zero";
  // Nov 16, DC on Slack at the order summary: neither was read and the order went out with $25). Up to 3 digits only and
  // nothing after it, so "delivery to 10019" / "delivery to 1460 Broadway" stay addresses.
  else if ((m = t.match(new RegExp('\\bdelivery(?:\\s+(?:fee|charge|cost))?\\b' + SET + '(zero|\\d{1,3}(?:\\.\\d{1,2})?)\\s*(?:dollars?|bucks)?\\s*(?:please)?[\\s.!]*$', 'i')))
    && !/\b(?:at|by|around|before|after|until|for)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:please)?[\s.!]*$|\b(?:time|am|pm|o'?clock|tomorrow|today|tonight|morning|afternoon|evening|noon)\b/i.test(t)) out.delivery_fee = /zero/i.test(m[1]) ? 0 : parseFloat(m[1]);
  else if (/\bfree\s+delivery\b|\bdelivery(?:\s+(?:fee|charge|cost))?\s+(?:(?:as|to|be|is|will|should|be|for|now)\s+){0,3}(?:free|complimentary|waived)\b|\b(?:no|remove|drop|waive|take\s+(?:out|off))\s+(?:the\s+)?delivery\s+(?:fee|charge|cost)\b/i.test(t)) out.delivery_fee = 0;
  return Object.keys(out).length ? out : null;
}
// "tax 8.8875%, tip $50.00 (flat), delivery $0.00"
function feesText(f) {
  const pct = r => (Math.round(r * 1e6) / 1e4) + '%', usd = v => '$' + Number(v).toFixed(2);
  return [f.tax_rate != null ? 'tax ' + pct(f.tax_rate) : '', f.service_rate != null ? 'service charge ' + pct(f.service_rate) : '',
    f.tip_amount != null ? 'tip ' + usd(f.tip_amount) + ' (flat)' : f.tip_rate != null ? 'tip ' + pct(f.tip_rate) : '',
    f.delivery_fee != null ? 'delivery ' + usd(f.delivery_fee) : ''].filter(Boolean).join(', ');
}
module.exports = { read, proposalAddress, fees, feesText };
