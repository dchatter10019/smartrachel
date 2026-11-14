// One sender, two email threads (DC, Nov 14: "rachel needs to distinguish requests from different emails ... it is
// overwriting the responses"). The saved basket was keyed sender+channel, so the threads overwrote each other and an
// email thread with an empty cart reloaded the OTHER thread's. Now an email session's basket is its own (gbrain.js).
const os = require('os'), fs = require('fs'), path = require('path');
process.env.RACHEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'basket-scope-'));
const G = require('../../gbrain.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
let cur = null; G.setBasketScope(() => cur);
const who = 'buyer@example-client.com';
(async () => {
  cur = 'email-aaaa-buyer'; await G.saveBasket(who, '[{"name":"HI USA wine"}]', '', 'plain');
  cur = 'email-bbbb-buyer'; await G.saveBasket(who, '[{"name":"Eterra Nov 17 wine"}]', '', 'plain');
  cur = 'email-aaaa-buyer'; ok('thread A gets its own basket back', /HI USA/.test(await G.getPackage(who, 'plain', 0)));
  cur = 'email-bbbb-buyer'; ok('thread B gets its own basket back', /Eterra/.test(await G.getPackage(who, 'plain', 0)));
  cur = 'email-cccc-buyer'; ok('a new thread never inherits another thread\'s basket', !(await G.getPackage(who, 'plain', 0)));
  cur = null; ok('the shopping-agent (no scope) with the thread\'s channel key reads the same basket', /HI USA/.test(await G.getPackage(who, 'plain@email-aaaa-buyer', 0)));
  cur = 'slack-session'; await G.saveBasket(who, '[{"name":"slack cart"}]', '', 'slack');
  cur = null; ok('Slack / connector keys unchanged (sender + channel)', G.basketKey(who, 'slack') === who + ':slack' && /slack cart/.test(await G.getPackage(who, 'slack', 0)));
  cur = 'email-bbbb-buyer'; await G.clearBasket(who, 'plain');
  cur = 'email-aaaa-buyer'; ok('clearing thread B leaves thread A', /HI USA/.test(await G.getPackage(who, 'plain', 0)));
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
