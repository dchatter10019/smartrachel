// The smallest wine / spirit bottle the customer accepts, read in code from their own words (Nov 9, DC on Claude Code:
// "only 750 mL or larger bottles for wine and spirits" — the package came back with 2 x Chandon Brut 375 mL). buildPackage
// leaves smaller bottles out of the wine and spirit slots (min_bottle_ml); every channel: rachel.js (Slack / email /
// WhatsApp / rachel_chat) and rachel-mcp.js rachel_build_package.
const UNIT = s => /^l|^lit/i.test(s) ? 1000 : /^cl/i.test(s) ? 10 : 1;
function minBottleMlIn(text) {
  const t = String(text || '').toLowerCase().replace(/<rachel_system_notes>[\s\S]*?<\/rachel_system_notes>/g, ' ');
  let m = t.match(/(\d+(?:\.\d+)?)\s*(ml|l|cl|liters?|litres?)\s*(?:bottles?\s*)?(?:or\s+(?:larger|bigger|more|above|up)|and\s+(?:up|above|larger|bigger)|\+|minimum|min\b|at\s+least)/)
    || t.match(/(?:at\s+least|minimum(?:\s+of)?|no\s+(?:smaller|less)\s+than|nothing\s+(?:smaller|less)\s+than|not\s+(?:smaller|less)\s+than)\s*(\d+(?:\.\d+)?)\s*(ml|l|cl|liters?|litres?)/);
  if (m) { const v = +m[1] * UNIT(m[2]); if (v >= 100 && v <= 3000) return Math.round(v); }
  if (/\bno\s+(?:375s?|half[- ]bottles?|splits?|minis?|small\s+bottles?)\b|\bfull[- ]size(?:d)?\s+bottles?\s+only\b|\bonly\s+full[- ]size/.test(t)) return 750;
  return 0;
}
module.exports = { minBottleMlIn };
