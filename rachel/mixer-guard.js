// What may fill a MIXER line (cocktail / mocktail ingredients) — same rules as the Voiceflow BuildPackage v2.7.14/15
// (DC, Oct 21; every channel):
//   - never a soft drink (Coke, Pepsi, Sprite, Dr Pepper, Mountain Dew, Fanta, Diet, Zero Sugar) unless the line names one
//     ("Sugar" matched Coca-Cola Zero Sugar);
//   - never food ("Mint" returned Oreo Mint cookies) unless the line itself names that food ("chocolate bitters" keeps
//     chocolate);
//   - "Soda Water" / "Club Soda" / "Sparkling Water" / "Seltzer" is plain soda water, never tonic ("Soda Water" returned
//     Canada Dry Tonic). No plain soda carried -> any non-tonic row, else nothing (the line goes "not carried").
const SOFT = /\b(coca[- ]?cola|coke|pepsi|sprite|dr\.? ?pepper|mountain dew|fanta|diet|zero sugar)\b/i;
const SOFT_ASKED = /cola|coke|pepsi|sprite|pepper|dew|fanta|diet/i;
const FOOD = /\b(cookies?|oreos?|crackers?|chips?|candy|chocolate|cake|brownies?|granola|gum|pretzels?|popcorn|ice cream|snacks?|jerky|nuts)\b/ig;
const PLAIN_SODA_ASK = /\b(club soda|soda water|sparkling water|seltzer(?: water)?)\b/i;
const PLAIN_SODA = /\b(club soda|soda water|sparkling water|seltzer water|perrier|pellegrino|topo chico)\b/i;

function rejectReason(term, name) {
  const t = String(term || '').toLowerCase(), n = String(name || '');
  if (SOFT.test(n) && !SOFT_ASKED.test(t)) return 'soft drink';
  const foods = (n.toLowerCase().match(FOOD) || []).filter(w => t.indexOf(w.replace(/s$/, '')) < 0);
  if (foods.length) return 'food (' + foods[0] + ')';
  return '';
}

// rows: catalog rows ({name, ...}) for a mixer line asked as `term`. Returns the rows allowed for it, plain soda first
// for a soda-water line. Logs every drop (rule 7).
function guardMixerRows(term, rows) {
  rows = rows || [];
  const dropped = [];
  let out = rows.filter(p => { const r = rejectReason(term, p && p.name); if (r) dropped.push((p && p.name) + ' (' + r + ')'); return !r; });
  if (PLAIN_SODA_ASK.test(String(term || '')) && !/tonic/i.test(String(term || ''))) {
    const plain = out.filter(p => PLAIN_SODA.test(p.name || '') && !/tonic/i.test(p.name || ''));
    const noTonic = out.filter(p => !/tonic/i.test(p.name || ''));
    const keep = plain.length ? plain : noTonic;
    out.filter(p => keep.indexOf(p) < 0).forEach(p => dropped.push(p.name + (/tonic/i.test(p.name || '') ? ' (tonic for a plain soda line)' : ' (not plain soda)')));
    out = keep;
  }
  if (dropped.length) console.log('[mixer-guard] ' + JSON.stringify(String(term || '')) + ': left out ' + dropped.slice(0, 6).join(', ') + (dropped.length > 6 ? ' +' + (dropped.length - 6) : ''));
  return out;
}

module.exports = { guardMixerRows, rejectReason };
