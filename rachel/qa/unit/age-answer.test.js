'use strict';
// parseAgeAnswer — the age gate (server.js) and the connector's rachel_verify_age customer_said (rachel-mcp.js).
const assert = require('assert');
const { parseAgeAnswer } = require('../../age-answer.js');
const cases = [
  ['yes', 'yes'], ["yes, I'm over 21", 'yes'], ['I am 34', 'yes'], ['21+', 'yes'],
  ['I am 17', 'no'], ["no I'm not over 21", 'no'], ['nope, 19. is that ok?', 'no'],
  ["I'm not sure", 'unclear'], ['send me wine', 'unclear'], ['', 'unclear'],
];
for (const [said, want] of cases) assert.strictEqual(parseAgeAnswer(said).answer, want, JSON.stringify(said));
console.log('age-answer: ' + cases.length + ' ok');
