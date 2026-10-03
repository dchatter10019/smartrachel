// Classifier model A/B on REAL turns (Oct 3, DC: cut cost — "Sonnet -> Haiku for the classifier?"). Same inputs to both
// models; rule-labelled messages are skipped (they never reach the LLM). Usage:
//   node qa/eval-classifier.js <pairs.json> <modelA> <modelB> [limit]   -> qa/evals/classifier-<stamp>.json + a summary
// pairs.json: [{msg, prev, qa}] (user message + the assistant message before it).
const fs = require('fs');
const C = require('../classify-intent.js');
const [, , file, A, B, lim] = process.argv;
const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
const kindOf = r => /how many/i.test(r) ? 'how_many' : /^\s*1[\.\)]\s[^\n]*\$\s?\d/m.test(r) ? 'numbered_list' : /shall i (go ahead|place)|\(yes\/no\)/i.test(r) ? 'yes_no' : /full name|phone number|email/i.test(r) ? 'contact' : 'other';
const ROUTE = { place_order: 0.75, show_basket: 0.65, change_time: 0.75, change_instructions: 0.75, change_contact: 0.75, recommend: 0.65, add_item: 0.8 };
const routed = c => c && ROUTE[c.intent] != null && c.confidence >= ROUTE[c.intent] ? c.intent : 'no-route';
(async () => {
  let pairs = JSON.parse(fs.readFileSync(file, 'utf8')).filter(p => !C.ruleIntent(p.msg, { lastKind: kindOf(p.prev) }));
  if (lim) pairs = pairs.slice(0, +lim);
  const one = async (model, p) => {
    const user = `Context: last assistant question kind = ${kindOf(p.prev)}; order step = none; basket items = 0.\nThe assistant's last message was: ${JSON.stringify(p.prev.slice(0, 160))}\nMessage: ${JSON.stringify(p.msg.slice(0, 400))}`;
    for (let i = 0; i < 3; i++) { try { const j = await C.callClassifier(model, 20000, user, key); return { intent: C.INTENTS.includes(j.intent) ? j.intent : 'other', ref: String(j.ref || ''), confidence: +j.confidence || 0 }; } catch (e) { if (i === 2) return { intent: 'error', ref: '', confidence: 0, err: e.message }; } }
  };
  const out = []; let k = 0;
  const worker = async () => { while (k < pairs.length) { const p = pairs[k++]; const [a, b] = await Promise.all([one(A, p), one(B, p)]); out.push({ msg: p.msg.slice(0, 200), prev: p.prev.slice(0, 160), qa: p.qa, a, b }); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  const n = out.length, same = out.filter(r => r.a.intent === r.b.intent).length, sameRoute = out.filter(r => routed(r.a) === routed(r.b)).length;
  const conf = {}; for (const r of out) if (routed(r.a) !== routed(r.b)) { const kk = routed(r.a) + ' -> ' + routed(r.b); conf[kk] = (conf[kk] || 0) + 1; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(__dirname + '/evals/classifier-' + stamp + '.json', JSON.stringify({ A, B, n, same, sameRoute, conf, rows: out }, null, 1));
  console.log(`${n} LLM-classified turns: intent agreement ${(100 * same / n).toFixed(1)}%, ROUTING agreement ${(100 * sameRoute / n).toFixed(1)}%`);
  console.log('routing disagreements (' + A + ' -> ' + B + '):', JSON.stringify(conf, null, 1));
  console.log('saved qa/evals/classifier-' + stamp + '.json');
})();
