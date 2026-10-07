// Per-bottle price ceilings for EVENT packages (DC, Oct 7). "Spend the whole budget" used to mean upgrading each bottle to
// the most expensive one that fit: 30 guests, $4,000, "mostly spirits mixed with coke and oj" got Opus One ($1,100),
// Phelps Insignia, Clase Azul and Weller Full Proof — sipping bottles under Coke, and a customer-facing critique of the
// package. An expert buys party bottles: the first pick (functions.js buildPackage targets) and the budget upgrades
// (shopping-agent menu_build passes 1-2) stay under these. Money left once every line is at its ceiling is left unspent and
// said plainly — never an upsell question. A customer's own price ask (wine_price_target, caps) is not limited by this.
const CEIL = { wine: 80, sparkling: 100, spirits_sipping: 90, spirits_mixed: 50 };

function eventCeiling(cat, label, mixed) {
  const c = String(cat || '').toLowerCase(), l = String(label || '').toLowerCase();
  if (/sparkling|champagne|prosecco|cava/.test(l)) return CEIL.sparkling;
  if (c === 'wine' || /wine/.test(l)) return CEIL.wine;
  if (c === 'spirits' || /vodka|rum|gin|tequila|bourbon|whisk|scotch|spirit|liquor/.test(l)) return mixed ? CEIL.spirits_mixed : CEIL.spirits_sipping;
  return 0;   // beer, mixers: no ceiling (not upgraded)
}

module.exports = { eventCeiling, CEIL };
