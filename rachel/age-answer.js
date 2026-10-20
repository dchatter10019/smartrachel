'use strict';
// Age answer (COMPLIANCE) — used by server.js's age gate and rachel-mcp.js rachel_verify_age (customer_said).
// Real bug: the gate treated a message as "yes" if it CONTAINED any of 'yes','ok','sure',
// 'i am','over 21' — checked before "no". "I am 17", "I'm not sure", "no I'm not over 21" and
// "nope, 19. is that ok?" all passed, while "I'm 25" and "21" were re-asked forever.
// Order matters: a stated age decides; then doubt; then negation; only then an affirmative
// at the START of the message (or an explicit "I'm over 21" anywhere).
function parseAgeAnswer(raw) {
  const m = String(raw || '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  const bare = m.replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  // A stated age: the whole message is a number, or a number with an age cue around it.
  // (Never a bare leading number — "3 bottles of Tito's" is not an age.)
  const ageM = bare.match(/^(\d{1,3})(?: years?(?: old)?| yrs?| yo)?$/) ||
               m.match(/\b(?:i'?m|im|i am|age(?: is)?|aged|turned|just turned)\s+(?:only\s+|just\s+)?(\d{1,3})\b/) ||
               m.match(/\b(\d{1,3})\s*(?:years? old|yrs? old|y\/o|yo)\b/) ||
               m.match(/^(?:no|nope|nah|yes|yeah|yep)[,.!\s]+(\d{1,3})\b/);
  if (ageM) { const n = Number(ageM[1]); if (n >= 21 && n <= 120) return { answer: 'yes', why: 'stated age ' + n }; if (n > 0 && n < 21) return { answer: 'no', why: 'stated age ' + n }; }
  if (/\b(not sure|unsure|don'?t know|dunno|idk|no idea|maybe|not certain)\b/.test(m)) return { answer: 'unclear', why: 'unsure' };
  if (/\b(under|younger than|less than|below)\s*21\b|\bnot\s+(?:yet\s+)?(?:21|over 21|old enough|of age)\b|\bminor\b|\bnot yet\b|\bunderage\b/.test(m)) return { answer: 'no', why: 'negated' };
  if (/^(no|nope|nah|negative|i'?m not|im not|i am not)\b/.test(bare)) return { answer: 'no', why: 'starts with no' };
  if (/^(yes|yeah|yep|yup|yea|ya|y|sure|ok|okay|correct|absolutely|definitely|of course|certainly|confirmed|affirmative|i am|i'?m over|im over|over 21|21 ?\+|i'?m 21|i am 21)\b/.test(bare)) return { answer: 'yes', why: 'affirmative' };
  if (/\b(i'?m|im|i am)\s+(over|above|older than)\s+21\b|\b21\s*\+|\b(i'?m|i am) of (legal )?(drinking )?age\b/.test(m)) return { answer: 'yes', why: 'states over 21' };
  return { answer: 'unclear', why: 'no age answer' };
}

module.exports = { parseAgeAnswer };
