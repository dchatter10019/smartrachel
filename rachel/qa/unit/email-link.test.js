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
eq('no name, TWO recent quotes -> no guess (asks instead)', pick(noName, [gen2, acme], now).session_id, null);
eq('a new order (not a change) -> new session', pick({ sender_email: 'sean@getbevvi.com', subject: 'New event', body: 'Need 3 cases of Bud Light for Friday' }, [gen2], now).session_id, null);


// ── Several open proposals (DC, Sep 30): weaker signals pick one, else "which proposal?" ──
const { answer, question, datesIn } = require('../../email-link.js');
const q1 = { session_id: 'email-q1-sean', sender_email: 'sean@getbevvi.com', client: 'Gen II Fund', subject: '', last_active: now - 2 * H, has_quote: true,
  event_date: 'October 12', address: '100 Federal Street, Floor 6, Boston, MA 02110', zip: '02110', total: 1840.5, items: 12, pdfs: ['bevvi-proposal-gen-ii-fund-1790707620981.pdf'] };
const q2 = { session_id: 'email-q2-sean', sender_email: 'sean@getbevvi.com', client: 'Acme Robotics', subject: '', last_active: now - 5 * H, has_quote: true,
  event_date: '10/20/2026', address: '1 Market St, San Francisco, CA 94104', zip: '94104', total: 620, items: 5, pdfs: ['bevvi-proposal-acme-robotics-1790700000000.pdf'] };
const q3 = Object.assign({}, q2, { session_id: 'email-q3-sean', client: 'Initech', event_date: 'Oct 12', address: '200 Clarendon St, Boston, MA 02116', zip: '02116', total: 3100, pdfs: [] });
const S = (subject, body, extra) => Object.assign({ sender_email: 'sean@getbevvi.com', subject, body }, extra || {});
eq('dates: "Oct 12" / "October 12th" / "10/12" / "2026-10-12" / "12 October"', [...datesIn('Oct 12, October 12th, 10/12, 2026-10-12, 12 October')], ['10-12']);
eq('dates: quantities are not dates', [...datesIn('2 cases of 30 cans, 12 bottles, 750 ml')], []);
eq('attached PDF names the quote', pick(S('Fwd: changes', 'please update the quote', { pdfs: ['bevvi-proposal-acme-robotics-1790700000000.pdf'] }), [q1, q2], now).session_id, 'email-q2-sean');
eq('a linked PDF in a forward names the quote', pick(S('Fwd: Drinks', 'see below, update the order', { body_full: 'see below\n---------- Forwarded message ---------\nhttp://3.138.180.46/proposals/bevvi-proposal-gen-ii-fund-1790707620981.pdf' }), [q2, q1], now).session_id, 'email-q1-sean');
eq('the generic attachment name never links', pick(S('Fwd: changes', 'please update the quote', { pdfs: ['bevvi-proposal.pdf'] }), [q1, q2], now).session_id, null);
eq('event date picks the one quote for Oct 20', pick(S('changes', 'For the Oct 20 event, please remove the Malbec from the proposal.'), [q1, q2], now).session_id, 'email-q2-sean');
eq('venue picks the Federal St quote', pick(S('changes', 'Can you update the order for 100 Federal St? add 2 more cases'), [q1, q2], now).session_id, 'email-q1-sean');
eq('total picks the ~$620 quote', pick(S('changes', 'On the $650 quote, swap the Corona for Modelo'), [q1, q2], now).session_id, 'email-q2-sean');
eq('date + venue beat date alone (two Oct 12 quotes)', pick(S('changes', 'Please update the Oct 12 proposal at 100 Federal Street'), [q3, q1], now).session_id, 'email-q1-sean');
const tie = pick(S('changes', 'Please update the Oct 12 proposal: remove the Malbec'), [q1, q2, q3], now);
eq('two quotes share the date -> ask between just those two', [tie.session_id, (tie.ask || []).map(c => c.session_id)], [null, ['email-q1-sean', 'email-q3-sean']]);
const amb = pick(S('Fwd: changes', 'Can you update the quote? Remove the Malbec please.'), [q1, q2], now);
eq('no signal, two recent quotes -> ask between them', [amb.session_id, (amb.ask || []).map(c => c.session_id)], [null, ['email-q1-sean', 'email-q2-sean']]);
eq('a new request with a matching date is NOT linked (not about changing a quote)', pick(S('New event', 'Need 3 cases of Bud Light for Oct 12 at 100 Federal St'), [q1], now).session_id, null);
eq('same client twice: the date picks the right one', pick(S('Gen II changes', 'update the Oct 12 proposal'), [Object.assign({}, q1, { session_id: 'email-q1b-sean', event_date: 'Nov 3', last_active: now - H }), q1], now).session_id, 'email-q1-sean');
const qt = question([q1, q2]);
eq('the question lists each quote with its details', [/1\. Gen II Fund — event October 12 — 100 Federal Street, Boston — \$1,840\.50 \(12 items\)/.test(qt), /2\. Acme Robotics/.test(qt), /Reply with the number or the client name/.test(qt)], [true, true, true]);
const ch = [q1, q2];
eq('answer "2"', answer('2', ch), { index: 1 });
eq('answer "#1 please"', answer('#1 please', ch), { index: 0 });
eq('answer "the second one"', answer('The second one', ch), { index: 1 });
eq('answer by client name', answer('The Acme Robotics one', ch), { index: 1 });
eq('answer by event date', answer('the October 12 event', ch), { index: 0 });
eq('answer "new"', answer("It's a new request", ch), { new: true });
eq('answer out of range -> not understood', answer('7', ch), null);
eq('answer unrelated -> not understood', answer('thanks!', ch), null);
console.log(failed ? '\nemail-link: ' + failed + ' FAILED' : '\nemail-link: all passed');
if (failed) process.exit(1);
