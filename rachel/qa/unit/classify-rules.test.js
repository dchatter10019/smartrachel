// Unit tests for the deterministic intent rules + ref grounding in rachel/classify-intent.js, on
// REAL customer messages from logs/rachel.log. Run: node qa/unit/classify-rules.test.js
// (precheck.sh runs every qa/unit/*.test.js during lint — a failure blocks the deploy).
const { ruleIntent, groundedRef } = require('../../classify-intent.js');

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
};
const r = (msg, lastKind) => { const x = ruleIntent(msg, { lastKind }); return x && [x.intent, x.ref, x.qty]; };

console.log('rules fire on unambiguous shapes (agreed with the LLM on 1,265 logged turns)');
eq('bare number after a list = pick', r('3', 'numbered_list'), ['select_option', '3', 0]);
eq('bare number after "how many" = quantity', r('2', 'how_many'), ['set_quantity', '', 2]);
eq('"yes" after a yes/no question', r('Yes please', 'yes_no'), ['confirm_yes', '', 0]);
eq('"no thanks" after a yes/no question', r('no thanks', 'yes_no'), ['confirm_no', '', 0]);
eq('show my basket', r('show my basket', 'other'), ['show_basket', '', 0]);
eq("what's in my cart? (the LLM said 'other')", r("what's in my cart?", 'other'), ['show_basket', '', 0]);
eq('add a Macallan 18 (the Sep 28 timeout turn)', r('add a Macallan 18', 'other'), ['add_item', 'Macallan 18', 0]);
eq('add a bottle of Veuve Clicquot (the LLM said other)', r('add a bottle of Veuve Clicquot', 'other'), ['add_item', 'Veuve Clicquot', 0]);
eq('add 3 bottles of Tito\'s', r("add 3 bottles of Tito's", 'other'), ['add_item', "Tito's", 3]);
eq('add two Whispering Angel to my cart', r('add two Whispering Angel to my cart', 'other'), ['add_item', 'Whispering Angel', 2]);

console.log('everything else goes to the LLM (null)');
eq('bare number with no list/how-many context', r('3', 'other'), null);
eq('"yes" when no yes/no question was asked', r('yes', 'other'), null);
eq('"Add to the order" (no product)', r('Add to the order', 'other'), null);
eq('add it', r('add it', 'other'), null);
eq('add a note for the driver', r('add a note for the driver', 'other'), null);
eq('add my phone number', r('add my phone number', 'other'), null);
eq('two products = a list, not one add', r("add Tito's and Patron", 'other'), null);
eq('quantity after the name', r('add Kim Crawford 2 bottles', 'other'), null);
eq('add some more', r('add some more', 'other'), null);
eq('question', r('can you add a gift message?', 'other'), null);
eq('Put it in the cart', r('Put it in the cart', 'numbered_list'), null);

console.log('ref grounding: the ref must be words the customer wrote');
eq('"Put it in the cart" + copied list name -> dropped', groundedRef("Kendall-Jackson Vintner's Reserve Cabernet Sauvignon", 'Put it in the cart'), '');
eq('"Kendall Pinot" + expanded ref -> customer words', groundedRef('Kendall-Jackson Pinot', 'Kendall Pinot'), 'kendall pinot');
eq('option number the customer wrote', groundedRef('4', "I'll take 4"), '4');
eq('option number the customer did NOT write', groundedRef('4', 'that one'), '');
eq('accents/apostrophes fold', groundedRef("Tito's Handmade Vodka", 'add titos'), 'titos');

(async () => {
  console.log('LLM call: Sonnet times out/errors -> one Haiku retry; both fail -> other, reason kept');
  const { classifyIntent } = require('../../classify-intent.js');
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  const realFetch = global.fetch; const models = [];
  const ok = { json: async () => ({ content: [{ text: '{"intent":"recommend","ref":"","qty":0,"confidence":0.9}' }] }) };
  const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e); };
  global.fetch = async (u, o) => { models.push(JSON.parse(o.body).model); return models.length === 1 ? abort() : ok; };
  let c = await classifyIntent('what goes well with salmon?', {});
  eq('retry on Haiku after a Sonnet timeout', [c.intent, c.source, models], ['recommend', 'llm-retry(sonnet:timeout)', ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']]);
  global.fetch = async () => ({ json: async () => ({ error: { type: 'overloaded_error' } }) });
  c = await classifyIntent('what goes well with salmon?', {});
  eq('both fail -> other with both reasons', [c.intent, c.source], ['other', 'error:sonnet:overloaded_error,haiku:overloaded_error']);
  models.length = 0; global.fetch = async (u, o) => { models.push(1); return ok; };
  c = await classifyIntent('3', { lastKind: 'numbered_list' });
  eq('a rule answers without calling the API', [c.intent, c.source, models.length], ['select_option', 'rule:bare-number-after-list', 0]);
  global.fetch = realFetch;
  console.log(failed ? '\nclassify-rules: ' + failed + ' FAILED' : '\nclassify-rules: all passed');
  process.exit(failed ? 1 : 0);
})();
