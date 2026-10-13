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
  const SET = '(?:[^.?!\\n$%\\d]{0,30}?)(?:\\bto|\\bbe|\\bat|\\bof|\\bis|=|:|\\bas)?\\s*:?\\s*';
  const NUM = '(\\d+(?:\\.\\d+)?)';
  let m;
  if ((m = t.match(new RegExp('\\b(?:sales\\s+)?tax(?:\\s+rate)?\\b' + SET + NUM + '\\s*(?:%|percent\\b|pct\\b)', 'i')))) out.tax_rate = parseFloat(m[1]) / 100;
  if ((m = t.match(new RegExp('\\bservice(?:\\s+(?:charge|fee))?\\b' + SET + NUM + '\\s*(?:%|percent\\b|pct\\b)', 'i')))) out.service_rate = parseFloat(m[1]) / 100;
  else if (/\b(?:no|remove|drop|waive|take\s+(?:out|off))\s+(?:the\s+)?service\s+(?:charge|fee)\b/i.test(t)) out.service_rate = 0;
  if ((m = t.match(new RegExp('\\b(?:tip|gratuity)\\b' + SET + '\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)', 'i')))) out.tip_amount = parseFloat(m[1].replace(/,/g, ''));
  else if ((m = t.match(new RegExp('\\b(?:tip|gratuity)\\b' + SET + NUM + '\\s*(?:%|percent\\b|pct\\b)', 'i')))) out.tip_rate = parseFloat(m[1]) / 100;
  else if (/\b(?:no|remove|drop|waive|take\s+(?:out|off))\s+(?:the\s+)?(?:tip|gratuity)\b/i.test(t)) out.tip_rate = 0;
  if ((m = t.match(new RegExp('\\bdelivery(?:\\s+(?:fee|charge|cost))?\\b' + SET + '\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)', 'i')))) out.delivery_fee = parseFloat(m[1].replace(/,/g, ''));
  else if ((m = t.match(new RegExp('\\bdelivery\\s+(?:fee|charge|cost)\\b' + SET + NUM + '\\b(?!\\s*%)', 'i')))) out.delivery_fee = parseFloat(m[1]);
  else if (/\bfree\s+delivery\b|\b(?:no|remove|drop|waive|take\s+(?:out|off))\s+(?:the\s+)?delivery\s+(?:fee|charge|cost)\b/i.test(t)) out.delivery_fee = 0;
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
