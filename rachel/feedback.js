// Feedback from the people Rachel serves becomes work for the debug-and-fix loop (DC, Oct 3: "how can we constantly
// train the model?"). Three sources, one file (logs/feedback.jsonl), read by ops/monitor.py (detector "feedback") ->
// a finding -> the nightly fixer:
//   correction  — a message that corrects Rachel ("I already told you", "Mara is not the customer", "you have the
//                 name from before"). Real (Oct 3, Foodie For All): DC corrected Rachel 3 times; nothing recorded it.
//   feedback    — a "Rachel feedback: ..." line in any message (email or chat).
//   unhappy     — dissatisfaction in any words ("you answered wrong", "not what I expected"; unhappyIn below, and the
//                 nightly conversation review for whatever the words miss — source "review").
//   thumbs_down — a 👎 on a Rachel reply in Slack (rachel_slack_bot.py writes it).
// Every entry keeps what Rachel said just before, so the fixer can see the mistake. QA sessions are marked qa:true
// (the monitor skips them).
const fs = require('fs');
const FILE = require('./data-dir.js').file('feedback.jsonl');

const CORRECTION = new RegExp([
  "\\bi(?:'ve| have)? (?:already |just )?(?:told|said|mentioned|gave|sent|answered) (?:you|this|that|it)\\b",
  '\\bas i (?:said|mentioned|wrote|told you)\\b',
  '\\byou (?:already )?have (?:it|that|this|the \\w+(?: \\w+)?) (?:from before|already|in the (?:email|thread))\\b',
  '\\b(?:is|was) not (?:not )?(?:the|a|our) (?:customer|client)\\b', "\\bisn'?t (?:the|our) (?:customer|client)\\b",
  "\\b(?:that'?s|this is|that is) (?:wrong|not right|incorrect|not correct|not what i (?:asked|wanted|said))\\b",
  "\\bnot what i (?:asked|wanted|said|meant)\\b", "\\byou(?:'re| are) wrong\\b", '\\bwrong (?:again|item|product|address|name|email|date)\\b',
  '\\bplease (?:re-?read|read (?:my|the) (?:email|message))\\b', '\\bfor the (?:second|third|fourth|\\d+(?:st|nd|rd|th)) time\\b',
  '\\b(?:still|again) (?:asking|wrong|missing)\\b', "\\bi (?:did ?n[o']t|never) (?:ask|say|order)\\b", '\\bwhy (?:did|do|are) you (?:keep|still)\\b',
].join('|'), 'i');

// Unhappy, however it is put (DC, Oct 7: "people won't write 'Rachel feedback' — they'll say I asked you this but you
// gave me something else, you answered wrong, this is not what I expected"). Kind "unhappy"; the nightly conversation
// review (ops/conversation-review.py unhappy_messages) catches what these words miss.
const UNHAPPY = new RegExp([
  "\\bi asked (?:you )?(?:for|about|to)\\b[^.?!\\n]{0,80}\\b(?:but|not|instead|and you|yet)\\b",
  "\\b(?:you |u )?(?:gave|sent|showed|provided|offered|got|answered|did|added|put) (?:me )?(?:\\w+ )?(?:the )?(?:wrong|incorrect)\\b",
  "\\b(?:answered|got (?:it|this|that)|did (?:it|this|that)) wrong\\b", "\\bwrong answer\\b",
  "\\bnot (?:what i (?:expected|was expecting|was looking for|need(?:ed)?|requested|ordered)|even close|right at all|helpful)\\b",
  "\\b(?:that'?s|this is|that is|it'?s) not (?:it|right|correct|what i)\\b",
  "\\byou (?:didn'?t|did not|never) (?:\\w+ )?(?:answer|listen|read|include|add|follow|understand|do what)\\b",
  "\\byou(?:'re| are) not (?:listening|understanding|reading|getting it|helping)\\b",
  "\\byou (?:missed|forgot|ignored|left out|skipped|dropped|misunderstood|misread|messed up|screwed up)\\b",
  "\\b(?:misunderstood|makes no sense|doesn'?t make (?:any )?sense|not making sense|confusing|confused me)\\b",
  "\\b(?:useless|unhelpful|frustrat\\w*|annoy\\w*|disappoint\\w*|terrible|awful|horrible|ridiculous|waste of (?:my )?time)\\b",
  "\\bwhy (?:would|did|do|are|is) (?:you|it|this|that)\\b[^.?!\\n]{0,60}\\b(?:wrong|instead|again|not|different|change|swap|remove|add)",
  "\\bwhere (?:is|are|did) (?:the|my)\\b[^.?!\\n]{0,40}\\bi (?:asked|ordered|wanted|requested)\\b",
  "\\b(?:that|this) (?:is|was) (?:not|n'?t) what\\b", "\\bwtf\\b", "\\bseriously\\s*\\?", "^\\s*(?:ugh|smh|no no)\\b", "\\?{3,}",
].join('|'), 'i');

function unhappyIn(message) {
  const t = String(message || '');
  if (t.length > 4000) return '';
  for (const line of t.replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (UNHAPPY.test(line)) return line.trim().slice(0, 300);
  }
  return '';
}

// The correction phrase in a message, or '' (quoted history is cut before this is called).
function correctionIn(message) {
  const t = String(message || '');
  if (t.length > 4000) return '';
  for (const line of t.replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    const m = line.match(CORRECTION);
    if (m) return line.trim().slice(0, 300);
  }
  return '';
}

// "Rachel feedback: the PDF had the wrong date" -> { text, rest } (rest = the message without that line), or null.
function feedbackLine(message) {
  const lines = String(message || '').replace(/\r/g, '').split('\n');
  const i = lines.findIndex(l => /^\s*\*?rachel\s+feedback\*?\s*[:\-–—]\s*\S/i.test(l));
  if (i < 0) return null;
  const text = lines[i].replace(/^\s*\*?rachel\s+feedback\*?\s*[:\-–—]\s*/i, '').trim();
  return { text, rest: lines.filter((_, j) => j !== i).join('\n').trim() };
}

function record(entry, log = console.log) {
  const e = Object.assign({ ts: new Date().toISOString() }, entry);
  e.qa = !!(e.qa || /^qa-/.test(String(e.session || '')) || /^(qa-[^@]*|rachel_qa)@getbevvi\.com$/i.test(String(e.who || '')));
  try { fs.appendFileSync(FILE, JSON.stringify(e) + '\n'); } catch (x) { log('[feedback] could not record (' + x.message + ')'); return; }
  log('[feedback] ' + e.kind + ' recorded' + (e.qa ? ' (QA)' : '') + ': ' + JSON.stringify(String(e.text || '').slice(0, 120)));
}

module.exports = { correctionIn, unhappyIn, feedbackLine, record, FILE };
