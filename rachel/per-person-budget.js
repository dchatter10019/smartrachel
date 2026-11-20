// A budget given PER PERSON ("$6 per person", "6 per person" answering "What's your total budget?", "budget is 35 a head").
// Nov 20, DC on Slack (Coral Springs, 100 guests): Rachel asked guests / hours / total budget; "100, 3 hours, 6 per person"
// was built as 6 DRINKS per person with no budget ($1,756), then "the budget is 6 per person" became a $6 TOTAL budget
// (PARAM-CHANGE OVERRIDE) and the build failed -> "did you mean $6 per person or per drink?".
// perPerson(message, {hoursGiven}) -> the dollars per person, or null. A count of drinks is never a budget:
// "6 drinks per person" / "6 drinks a person" -> null. A bare "N per person" is a budget when the message also says
// budget / $ / dollars, or gives the event length (hours) — then it can't be drinks per person (the builder takes hours OR
// drinks per person, and Rachel's intake asks guests, hours, budget).
const PP = /(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:\$|dollars?|bucks|usd)?\s*(?:\/|per|a|an|each)\s*(?:person|head|guest|attendee|pax|pp)\b|(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:pp|pph)\b/i;
function perPerson(message, opts) {
  const m = String(message || '');
  const x = m.match(PP);
  if (!x) return null;
  const n = parseFloat(x[1] || x[2]);
  if (!(n > 0) || n > 1000) return null;
  const at = x.index, around = m.slice(Math.max(0, at - 25), at + x[0].length + 15);
  if (/\bdrinks?\b|\bservings?\b|\bpours?\b|\bcocktails?\b|\bbeers?\b|\bglass(?:es)?\b/i.test(around.replace(x[0], ' ').slice(0, 40)) && !/\$/.test(x[0])) return null;
  if (/\bdrinks?\s*(?:\/|per|a|an|each)\s*(?:person|head|guest)/i.test(m) && !/\$/.test(x[0]) && !/\bbudget\b/i.test(m)) return null;
  const moneyCue = /\$/.test(x[0]) || /\b(?:budget|dollars?|bucks|usd|spend|cost)\b/i.test(m);
  const hoursGiven = (opts && opts.hoursGiven) || /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b/i.test(m);
  return moneyCue || hoursGiven ? n : null;
}
module.exports = { perPerson };
