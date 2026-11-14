// chrono's forwardDate moves a date with no year that is TODAY into next year once today's midnight has passed: on Nov 14,
// 2026 at 18:50 UTC "Saturday 11/14 (1-3pm ET)" parsed as Nov 14, 2027 — the email order showed "Sun, Nov 14" (a Sunday in
// 2027) and would have been placed a year late (DC's "Bevvi - Nov 14th Delivery" thread). Today stays today; every other date
// keeps chrono's forward reading.
const chrono = require('chrono-node');
function parse(text, ref, opts) {
  const now = ref || new Date();
  // "Create the order now" / "asap" is not a delivery time (Nov 14: "now" = 19:00 UTC was booked as 7-8 PM ET)
  const out = chrono.parse(text, now, Object.assign({ forwardDate: true }, opts || {})).filter(r => {
    if (/^(?:right\s+)?now$|^asap$|^immediately$/i.test(String(r.text).trim())) { console.log('[date] "' + r.text + '" is not a delivery time — ignored'); return false; }
    return true;
  });
  for (const r of out) {
    for (const c of [r.start, r.end]) {
      if (!c || c.isCertain('year') || !c.isCertain('day')) continue;
      const d = c.date();
      if (d.getFullYear() === now.getFullYear() + 1 && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        c.assign('year', now.getFullYear());
        console.log('[date] "' + r.text + '" is today, not next year');
      }
    }
  }
  return out;
}
module.exports = { parse };
