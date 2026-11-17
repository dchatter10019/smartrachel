// chrono's forwardDate moves a date with no year that is TODAY into next year once today's midnight has passed: on Nov 14,
// 2026 at 18:50 UTC "Saturday 11/14 (1-3pm ET)" parsed as Nov 14, 2027 — the email order showed "Sun, Nov 14" (a Sunday in
// 2027) and would have been placed a year late (DC's "Bevvi - Nov 14th Delivery" thread). Today stays today; every other date
// keeps chrono's forward reading.
// "today" / "tomorrow" / "tonight" / a bare weekday are read on the DELIVERY ZONE's calendar, never the server's (UTC): Nov 15,
// 2026 at 8:06 PM ET (01:06 UTC Nov 16) DC typed "tomorrow 3 pm EST" on Slack — he meant Mon Nov 16, the order was booked for
// Tue Nov 17. opts.zone (an IANA zone) = the wall clock to read against; results stay wall-clock fields (getHours() / getDate()
// = what the customer typed), as every caller already reads them.
const chrono = require('chrono-node');
// "now" as a Date whose LOCAL fields are the wall clock in `zone` (whatever the process time zone is).
function wallNow(zone, ref) {
  const at = ref || new Date();
  if (!zone) return at;
  try {
    const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)) p[x.type] = x.value;
    return new Date(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  } catch (e) { console.log('[date] unknown time zone ' + zone + ' — reading against the server clock'); return at; }
}
function parse(text, ref, opts) {
  const o = Object.assign({}, opts || {});
  const zone = o.zone; delete o.zone;
  const now = zone ? wallNow(zone, ref) : (ref || new Date());
  // "Create the order now" / "asap" is not a delivery time (Nov 14: "now" = 19:00 UTC was booked as 7-8 PM ET)
  const out = chrono.parse(text, now, Object.assign({ forwardDate: true }, o)).filter(r => {
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
module.exports = { parse, wallNow };
