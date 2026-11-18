// A question never rebuilds the basket (rebuild-guard.js; DC, Nov 18).
const assert = require('assert');
const { questionOnly } = require('../../rebuild-guard.js');
const ev = { guests: 140, hours: 2, budget: 4000 };
const Q = ['Why so much gin?', 'Is that enough for 140 guests?', 'how many drinks per person is that?', 'What is the total?',
  'Can you explain why there are 6 bottles of red?', 'Which tequila is that?', 'does that include mixers?', 'Is the $4000 budget covered?'];
const NOT = ['Can you add 2 bottles of Tito\'s?', 'what about 200 guests?', 'Could we swap the gin for Hendrick\'s?', 'make it cheaper?',
  'Can you rebuild it for 3 hours?', 'Remove the beer?', 'Can we do a $3,000 budget instead?', 'I need a menu for 50 people', 'Even',
  'Use only 750 ml bottles', 'Can you send the proposal?', 'can we get more white wine?', '{"_system":"place_order"}', 'Sounds good'];
for (const m of Q) assert.ok(questionOnly(m, ev), 'question only: ' + m);
for (const m of NOT) assert.strictEqual(questionOnly(m, ev), '', 'not question-only: ' + m);
assert.ok(questionOnly('Is that enough for 140 guests?', {}) === '', 'an unknown event: 140 guests is new');
console.log('rebuild-guard: ' + (Q.length + NOT.length + 1) + ' checks passed');
