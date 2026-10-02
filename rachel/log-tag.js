// QA log tagging. Every console line written while serving a QA session ends with « <session> »,
// in rachel AND in shopping-agent (the session rides along on the x-qa-session header of every
// call to :8300). The QA runner reads only its own scenario's lines, so scenarios can run in
// parallel and log_contains / log_not_contains still see just their own turn. Non-QA traffic is
// never tagged: production log lines are unchanged. Tag at the END so '^[classify]' greps still match.
const { AsyncLocalStorage } = require('async_hooks');
const util = require('util');
const als = new AsyncLocalStorage();
const HEADER = 'x-qa-session';
const isQASession = s => /^qa-[\w.-]{1,120}$/i.test(String(s || ''));

let installed = false;
function install() {
  if (installed) return; installed = true;
  for (const lvl of ['log', 'info', 'warn', 'error']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => {
      const st = als.getStore();
      if (!st || !st.tag) return orig(...a);
      orig(util.format(...a).split('\n').map(l => l + ' «' + st.tag + '»').join('\n'));
    };
  }
  // Carry the session to shopping-agent on every call made while serving a QA turn.
  if (typeof globalThis.fetch === 'function') {
    const f0 = globalThis.fetch;
    globalThis.fetch = (url, opts) => f0(url, withQAHeader(url, opts));
  }
}

// fetch options with the x-qa-session header added when this is a QA turn calling shopping-agent.
// rachel.js / server.js use node-fetch through their own wrappers, which call this directly
// (first deploy of the tagging: those calls went out untagged and every [buildPackage] line was lost).
function withQAHeader(url, opts) {
  const st = als.getStore();
  // 8300 = production's shopping-agent, 8301 = staging's (ops/staging.sh --with-shopping-agent)
  if (!(st && st.tag && /^https?:\/\/(127\.0\.0\.1|localhost):830[01]\//.test(String(url)))) return opts;
  opts = Object.assign({}, opts || {}); opts.headers = Object.assign({}, opts.headers || {}, { [HEADER]: st.tag });
  return opts;
}

// Run fn inside the session's context when it is a QA session; otherwise just run it.
function runTagged(session, fn) { return isQASession(session) ? als.run({ tag: String(session) }, fn) : fn(); }

module.exports = { install, runTagged, withQAHeader, HEADER, isQASession };
