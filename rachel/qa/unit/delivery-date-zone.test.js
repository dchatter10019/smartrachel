// "tomorrow" / "today" / a weekday are read on the delivery zone's calendar, never the server's UTC day (DC, Nov 17: on Sun
// Nov 15 at 8:06 PM ET — 01:06 UTC Nov 16 — "tomorrow 3 pm EST" on Slack was booked for Tue Nov 17, not Mon Nov 16).
const CT = require('../../chrono-today.js');
let failed = 0;
function eq(label, got, want) { const ok = got === want; if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  got ' + got + ', want ' + want)); }
const d = (t, iso, zone) => { const r = CT.parse(t, new Date(iso), { zone })[0]; if (!r) return 'none'; const x = r.start.date(); return (x.getMonth() + 1) + '/' + x.getDate() + ' ' + x.getHours() + ':' + String(x.getMinutes()).padStart(2, '0'); };
const SUN_8PM_ET = '2026-11-16T01:06:28Z';
eq('DC\'s Slack message: tomorrow at 8 PM ET Sunday = Monday', d('tomorrow 3 pm', SUN_8PM_ET, 'America/New_York'), '11/16 15:00');
eq('today in Pacific at 5:06 PM PT = Sunday', d('today at 9pm', SUN_8PM_ET, 'America/Los_Angeles'), '11/15 21:00');
eq('a weekday: "Monday 2pm" = the next day', d('Monday 2pm', SUN_8PM_ET, 'America/New_York'), '11/16 14:00');
eq('a written date with no year that is today in ET stays this year', d('11/15 9pm', SUN_8PM_ET, 'America/New_York'), '11/15 21:00');
eq('daytime: tomorrow is unchanged', d('tomorrow 3pm', '2026-11-16T15:00:00Z', 'America/New_York'), '11/17 15:00');
eq('no zone given: the old reading (server clock)', d('tomorrow 3 pm', SUN_8PM_ET), '11/17 15:00');
const w = CT.wallNow('America/New_York', new Date(SUN_8PM_ET));
eq('wallNow fields are ET wall clock', w.getDate() + ' ' + w.getHours(), '15 20');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
