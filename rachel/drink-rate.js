// The customer's drink rate is drinks per person for the WHOLE event, never per hour (DC, Nov 25: "its the total drinks.. not by
// hour"). Real (Slack, Compass Group, 1000 guests / 2 h): "Your consumption rate was approx 1.5 drinks. That is approved." — the
// model computed 1,000 x 2 h x 1.5 = 3,000 drinks (should be ~1,500) and trimmed the beer from that.
// rateIn(text) -> { dpp, said } | null. "per hour / an hour / hourly / /hr" next to the number = not this rate (left to the rule).

function rateIn(text) {
  const t = String(text || '').replace(/[*_~`]/g, '').replace(/&amp;/g, '&');
  const pats = [
    /\b(?:consumption|drinking|drink)\s+rate\b[^.\n]{0,25}?\b(?:is|was|of|=|:|at|approx(?:imately)?\.?|about|around|~)?\s*(?:approx(?:imately)?\.?\s*|about\s+|around\s+|~\s*)?(\d+(?:\.\d+)?)\s*(?:drinks?)?/i,
    /\b(\d+(?:\.\d+)?)\s*drinks?\s+(?:consumption\s+)?rate\b/i,
    /\b(\d+(?:\.\d+)?)\s*drinks?\s+(?:per|a|each|\/)\s*(?:person|guest|head|attendee|pp)\b/i,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (!m) continue;
    const dpp = parseFloat(m[1]);
    if (!(dpp > 0 && dpp <= 12)) continue;
    const near = t.slice(Math.max(0, m.index - 5), m.index + m[0].length + 25);
    if (/\b(?:per|an|each|every|a)\s+hour\b|\bhourly\b|\/\s*h(?:ou)?r\b|\bph\b/i.test(near)) continue;
    return { dpp, said: m[0].trim() };
  }
  return null;
}

// The note the model gets every turn once a rate is known.
const note = r => '## DRINK RATE (the customer\'s, read in code)\n' + r.dpp + ' drinks per person for the WHOLE event — NOT per hour. ' +
  'Total drinks = ' + r.dpp + ' x guests (never x hours). Use it for every quantity and every "what is still needed" calculation.';

module.exports = { rateIn, note };
