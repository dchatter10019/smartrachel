// Lines taken out of the basket in code (edit reader, quote edits), remembered for 30 minutes with their quantity, so a later
// pick that names one of them as its original replaces it at that quantity (Nov 20 nightly, pick-plus-question / F-0016:
// "Instead of the Bacardi ... same 5 bottles" removed the 5x Bacardi, the Buffalo Trace picked next went in at 1x while the
// reply said 5). state.recentRemoved = [{ name, qty, at }].
const basketLineFor = require('./basket-line.js');

const KEEP_MS = 30 * 60 * 1000;

function live(state, now) {
  const t = now || Date.now();
  return (state.recentRemoved || []).filter(r => r && r.name && t - (r.at || 0) < KEEP_MS);
}

// rows: [{ name, qty }] (basket lines or quote-edit changes)
function record(state, rows, now) {
  const t = now || Date.now();
  const add = (rows || []).map(r => ({ name: String(r.name || r.label || ''), qty: parseInt(r.qty || r.quantity || r.from, 10) || 0, at: t })).filter(r => r.name && r.qty > 0);
  if (!add.length) return;
  const nz = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const keep = live(state, t).filter(r => !add.some(a => nz(a.name) === nz(r.name)));
  state.recentRemoved = keep.concat(add).slice(-20);
  console.log('[removed-lines] recorded ' + JSON.stringify(add.map(a => a.qty + 'x ' + a.name)) + ' (30 min)');
}

// The recorded line the original names (whole words, basket-line.js) -> { name, qty } or null.
function lookup(state, originalItem, now) {
  const rows = live(state, now);
  if (!rows.length || !originalItem) return null;
  const i = basketLineFor(rows, originalItem);
  return i >= 0 ? { name: rows[i].name, qty: rows[i].qty } : null;
}

// confirm_substitute's replacement_quantity from the model: a whole number, 1 or more (a number or a digits-only string).
// Anything else -> 0 = ignored (the substitute then asks the customer again when no quantity is known).
function validQty(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 0;
  const t = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof t === 'string' && !/^\d+$/.test(t)) return 0;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 ? n : 0;
}

// replacement_quantity is used only when the customer's CURRENT message carries that exact number (digits, whole token:
// "5" is in "make it 5" / "5 bottles", not in "15", "2.5" or "$5.99"). A number the model took from an earlier turn or made
// up is ignored (DC, Nov 20).
function qtyInMessage(n, message) {
  if (!n) return false;
  return new RegExp('(?<![\\d.,$])' + n + '(?![\\d]|[.,]\\d)').test(String(message || ''));
}

module.exports = { record, lookup, validQty, qtyInMessage, KEEP_MS };
