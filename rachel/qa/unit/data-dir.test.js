// Unit tests for data-dir.js — a staging Rachel never writes production's state files (DC, Oct 1).
// (precheck.sh runs qa/unit/*.test.js.) Each case runs in a child process: the dir is read at require time.
const { execFileSync } = require('child_process');
const os = require('os'), path = require('path');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const MOD = path.join(__dirname, '../../data-dir.js');
function run(env, port) {
  const e = Object.assign({}, process.env, env); if (!('RACHEL_DATA_DIR' in env)) delete e.RACHEL_DATA_DIR;
  try {
    const out = execFileSync('node', ['-e', `const d=require(${JSON.stringify(MOD)}); d.assertSafe(${port}); console.log('FILE ' + d.file('flow-state.json'))`],
      { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, file: (out.match(/FILE (\S+)/) || [])[1] };
  } catch (err) { return { code: err.status, refused: /REFUSED/.test(String(err.stderr)) }; }
}
const tmp = path.join(os.tmpdir(), 'rachel-data-dir-test');
eq('production port, no env -> production dir', run({}, 3500), { code: 0, file: '/home/ubuntu/logs/flow-state.json' });
eq('staging port, no env -> refused', run({}, 3501), { code: 1, refused: true });
eq('staging port, env = production dir -> refused', run({ RACHEL_DATA_DIR: '/home/ubuntu/logs/' }, 3501), { code: 1, refused: true });
eq('staging port, own dir -> its own files', run({ RACHEL_DATA_DIR: tmp }, 3501), { code: 0, file: path.join(tmp, 'flow-state.json') });
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
