// A staging Rachel (ops/staging.sh: RACHEL_PORT 3501, its own RACHEL_DATA_DIR, QA_MODE=1) runs code under test and
// must never reach a customer: every session is dry-run, no email is sent, and a place_order always carries dry_run
// (even if a code path forgot the QA flag). Production (QA_MODE unset) is unchanged.
// SHOPPING_AGENT_URL lets staging use its own shopping-agent (8301) when a change touches store-agent/.
const QA_MODE = process.env.QA_MODE === '1';
const SA_URL = process.env.SHOPPING_AGENT_URL || 'http://127.0.0.1:8300/mcp';

// The arguments of a shopping-agent tool call, made safe for staging.
function guardTool(name, args) {
  if (QA_MODE && name === 'place_order' && args && !args.dry_run) {
    console.log('[staging] QA_MODE — place_order forced to dry_run');
    return Object.assign({}, args, { dry_run: true });
  }
  return args;
}

if (QA_MODE) console.log('[staging] QA_MODE=1 — every session dry-run, no email sent, place_order always dry_run; shopping-agent ' + SA_URL);

module.exports = { QA_MODE, SA_URL, guardTool };
