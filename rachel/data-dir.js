// Where Rachel keeps her state (sessions, conversation history, saved baskets, contacts, events).
// Production: /home/ubuntu/logs. A staging Rachel (RACHEL_PORT 3501) sets RACHEL_DATA_DIR to its own
// directory — it must never load and rewrite production's flow-state.json / chat-sessions.json, which
// would wipe live customers' conversations (DC, Oct 1). assertSafe() refuses to start a non-production
// port on the production directory, so a forgotten env var fails loudly instead of clobbering prod.
const fs = require('fs');
const path = require('path');

const PROD_DIR = '/home/ubuntu/logs';
const PROD_PORT = 3500;
const DIR = path.resolve(process.env.RACHEL_DATA_DIR || PROD_DIR);

function file(name) { return path.join(DIR, name); }

function assertSafe(port) {
  if (Number(port) !== PROD_PORT && DIR === PROD_DIR) {
    console.error('[data-dir] REFUSED to start: port ' + port + ' is not production but RACHEL_DATA_DIR is the production directory ' +
      PROD_DIR + ' — it would overwrite live sessions. Set RACHEL_DATA_DIR (ops/staging.sh does).');
    process.exit(1);
  }
  fs.mkdirSync(DIR, { recursive: true });
  console.log('[data-dir] state in ' + DIR + (DIR === PROD_DIR ? ' (production)' : ''));
}

module.exports = { DIR, PROD_DIR, file, assertSafe };
