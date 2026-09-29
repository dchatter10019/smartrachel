// Unit tests for email-link.js — a NEW email thread continuing an earlier quote (Sep 29: Sean forwarded the
// Gen II Fund edits as a new thread; the agent started a fresh session with no basket). (precheck runs these.)
const { pick } = require('../../email-link.js');
const { latest } = require('../../email-body.js');
const fwd = require('./fixtures/gen2-forwarded-edits.json');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const now = Date.parse('2026-09-29T18:45:00Z'), H = 36e5;
const gen2 = { session_id: 'email-gen2-sean', sender_email: 'sean@getbevvi.com', client: 'Gen II Fund', subject: 'Alcohol Menu Proposal Needed - Gen II Fund', last_active: now - 2 * H, has_quote: true };
const acme = { session_id: 'email-acme-sean', sender_email: 'sean@getbevvi.com', client: '', subject: 'Drinks for Friday - Acme Robotics', last_active: now - 5 * H, has_quote: true };
const msg = { sender_email: 'Sean@getbevvi.com', subject: fwd.subject, body: latest(fwd.body).text };

eq("the real forward links to the Gen II quote (client named in Sean's note)", pick(msg, [acme, gen2], now).session_id, 'email-gen2-sean');
eq('client from the old subject when no saved client', pick({ sender_email: 'sean@getbevvi.com', subject: 'Fwd: Acme Robotics changes', body: 'see below' }, [gen2, acme], now).session_id, 'email-acme-sean');
eq('another sender never links', pick(Object.assign({}, msg, { sender_email: 'someone@else.com' }), [gen2], now).session_id, null);
eq('a session without a quote never links', pick(msg, [Object.assign({}, gen2, { has_quote: false })], now).session_id, null);
eq('older than 30 days never links', pick(msg, [Object.assign({}, gen2, { last_active: now - 31 * 24 * H })], now).session_id, null);
const noName = { sender_email: 'sean@getbevvi.com', subject: 'Fwd: changes', body: 'Can you update the quote? Remove the Malbec please.' };
eq('no name, one recent quote, a change request -> that quote', pick(noName, [gen2], now).session_id, 'email-gen2-sean');
eq('no name, TWO recent quotes -> new session (no guessing)', pick(noName, [gen2, acme], now).session_id, null);
eq('a new order (not a change) -> new session', pick({ sender_email: 'sean@getbevvi.com', subject: 'New event', body: 'Need 3 cases of Bud Light for Friday' }, [gen2], now).session_id, null);

console.log(failed ? '\nemail-link: ' + failed + ' FAILED' : '\nemail-link: all passed');
if (failed) process.exit(1);
