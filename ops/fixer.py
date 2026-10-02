#!/usr/bin/env python3
"""Rachel fixer — Debug-and-Fix Loop spec, Part C. For each open finding (severity order, up to the nightly budget):
classify it against ops/scope.yaml; if fixable, run headless Claude Code in a git worktree on branch fix/<id> to reproduce
it as a QA scenario, fix it and commit; then PROVE it here, independently of what the agent says:
  the new scenario FAILS on staging from the base, PASSES on staging from the branch, and the smoke set passes on the branch;
  the branch touches no protected path/region (scope.yaml).
Result -> logs/fixer/<id>.json (+ the agent transcript <id>.log), a review post (Slack #rachel-ops once OPS_SLACK_CHANNEL is
set; until then logs/fixer/<id>.post.txt). Nothing is deployed here — ops/deploy-fix.sh does that on DC's ✅ (Part D).

  ops/fixer.py                     nightly: open findings, up to fixer.max_per_night
  ops/fixer.py --finding F-0007    just that one
  ops/fixer.py --dry-post          post to OPS_TEST_CHANNEL (or the file) instead of #rachel-ops
  ops/fixer.py --seed synonym      acceptance test: plant a known bug on a throwaway base branch + a matching finding, fix it
  ops/fixer.py --plan              classify the open findings and print what would run; no agent, no tokens
Kill switch: ops/PAUSE exists -> exit at once. Budget: fixer.nightly_budget_usd in ops/monitor.yaml (unset = no agent runs).
"""
import argparse, datetime, fnmatch, glob, json, os, re, shutil, subprocess, sys, time
import yaml
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import monitor as MON

HOME = '/home/ubuntu'; OPS = HOME + '/ops'; WORK = HOME + '/work'; OUT = HOME + '/logs/fixer'
SEV = ['critical', 'high', 'medium', 'low', 'info']

def log(m): print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + ' [fixer] ' + m, flush=True)
def sh(cmd, cwd=HOME, timeout=None, check=False):
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
    if check and r.returncode: raise RuntimeError('%s -> %d: %s' % (cmd, r.returncode, (r.stderr or r.stdout)[-400:]))
    return r

def load(path): return yaml.safe_load(open(path))

# ── scope: what a branch may touch ──────────────────────────────────────────────────────────────────────────────────
def scope_violations(scope, base, branch, cwd=HOME):
    names = [n for n in sh(['git', 'diff', '--name-only', base + '...' + branch], cwd).stdout.split('\n') if n]
    bad = []
    for n in names:
        for p in scope.get('protected_paths', []):
            if n == p or (p.endswith('/') and n.startswith(p)) or fnmatch.fnmatch(n, p): bad.append('protected path: ' + n)
    diff = sh(['git', 'diff', '-U0', base + '...' + branch], cwd).stdout
    for line in diff.split('\n'):
        if (line.startswith('+') or line.startswith('-')) and not line.startswith(('+++', '---')):
            for pat in scope.get('protected_patterns', []):
                if re.search(pat, line): bad.append('protected region (%s): %s' % (pat, line[:120]))
    scen = [n for n in names if n.startswith('rachel/qa/scenarios/')]
    changed_existing = [n for n in scen if sh(['git', 'cat-file', '-e', base + ':' + n], cwd).returncode == 0]
    if len(changed_existing) > scope.get('max_scenarios_changed', 3): bad.append('changes %d existing scenarios (max %d)' % (len(changed_existing), scope.get('max_scenarios_changed', 3)))
    return sorted(set(bad)), names

# ── worktree + staging ──────────────────────────────────────────────────────────────────────────────────────────────
def make_worktree(fid, base):
    wt = WORK + '/' + fid; br = 'fix/' + fid
    if os.path.exists(wt): sh(['git', 'worktree', 'remove', '--force', wt])
    sh(['git', 'branch', '-D', br])
    sh(['git', 'worktree', 'add', wt, '-b', br, base], check=True)
    for d in ['rachel/node_modules', 'store-agent/node_modules', 'rachel/venv']:   # untracked deps: link, never copy
        if os.path.exists(HOME + '/' + d) and not os.path.exists(wt + '/' + d): os.symlink(HOME + '/' + d, wt + '/' + d)
    return wt, br

def staging_run(tree, args, touches_sa):
    """Start staging from <tree>, run qa/run.py <args> against it, stop it. -> (passed: bool, tail)"""
    sh([OPS + '/staging.sh', 'stop'])
    st = sh([OPS + '/staging.sh', 'start', tree] + (['--with-shopping-agent'] if touches_sa else []), timeout=180)
    if st.returncode: return None, 'staging failed to start: ' + (st.stdout + st.stderr)[-300:]
    try:
        r = sh(['./qa/run.py', '--url', 'http://127.0.0.1:3501'] + args, cwd=tree + '/rachel', timeout=1800)
        tail = '\n'.join(l for l in r.stdout.split('\n') if l and not l.startswith('       '))[-1500:]
        return r.returncode == 0, tail
    finally:
        sh([OPS + '/staging.sh', 'stop'])

# ── the agent ───────────────────────────────────────────────────────────────────────────────────────────────────────
ALLOWED = ['Read', 'Grep', 'Glob', 'Edit', 'Write',
           'Bash(node:*)', 'Bash(python3:*)', 'Bash(./qa/run.py:*)', 'Bash(/home/ubuntu/ops/staging.sh:*)',
           'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)',
           'Bash(grep:*)', 'Bash(sed -n:*)', 'Bash(tail:*)', 'Bash(head:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(wc:*)']
DENIED = ['Bash(systemctl:*)', 'Bash(sudo:*)', 'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git checkout:*)', 'Bash(git reset:*)',
          'Bash(git rebase:*)', 'Bash(git worktree:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(/home/ubuntu/precheck.sh:*)', 'Bash(rm:*)',
          'Read(//etc/**)', 'Read(//home/ubuntu/config/**)', 'Read(//etc/systemd/**)',
          'Edit(//home/ubuntu/rachel/**)', 'Edit(//home/ubuntu/store-agent/**)', 'Edit(//home/ubuntu/ops/**)', 'Edit(//home/ubuntu/CLAUDE.md)',
          'Write(//home/ubuntu/rachel/**)', 'Write(//home/ubuntu/store-agent/**)', 'Write(//home/ubuntu/ops/**)', 'Write(//etc/**)',
          'Edit(**/prompt.md)', 'Write(**/prompt.md)']

def prompt_for(f, scope, wt, base, extra=''):
    claude_md = open(HOME + '/CLAUDE.md').read()
    return f"""You are Rachel's nightly fixer (Debug-and-Fix Loop, Part C). You work ONLY in the git worktree {wt} on branch
fix/{f['id']} (base: {base}). Nothing you do reaches customers: you cannot deploy, push or merge — DC reviews and approves.

FINDING {f['id']} ({f['severity']}, detector {f['detector']}, seen {f['count']}x, {f['first_seen']} .. {f['last_seen']}):
{f['summary']}
Evidence (redacted log lines / events):
""" + '\n'.join('  ' + e for e in f.get('evidence', [])[-25:]) + f"""
Sessions: {', '.join(f.get('sessions', [])[:10]) or '-'}
{extra}
CONTRACT — satisfy all of it, or return a diagnosis:
1. FIRST write a QA scenario in {wt}/rachel/qa/scenarios/ (next free number; name: "fix-{f['id'].lower()}-<what>") that
   reproduces the finding. The worktree still holds the base code, so prove it FAILS there before you change any code:
   `/home/ubuntu/ops/staging.sh start {wt}` (add --with-shopping-agent if the bug is in store-agent/ or the rachel/ files it
   loads), then `cd {wt}/rachel && ./qa/run.py --url http://127.0.0.1:3501 --only <scenario-name>`, then
   `/home/ubuntu/ops/staging.sh stop`. No failing reproduction -> outcome "diagnosed".
2. Make the SMALLEST fix that makes it pass. Log the decision the fix makes ("[...] reason") as CLAUDE.md requires.
3. Restart staging from {wt} (stop, start) and run `./qa/run.py --url http://127.0.0.1:3501 --smoke` plus your scenario. All
   green, or stop and report which broke. Always `/home/ubuntu/ops/staging.sh stop` when done.
4. `git add` + `git commit` on fix/{f['id']} with a message naming the bug and the fix. Do NOT push, merge or checkout.
5. If the fix would touch anything on the diagnose list or a protected path, STOP and return outcome "diagnosed" saying why.
6. End your reply with ONE line of JSON and nothing after it:
{{"finding_id":"{f['id']}","outcome":"fixed|diagnosed|failed","summary":"<plain English, <=5 sentences>","cause":"...","files_changed":[...],"scenario":"<name>","suite":{{"passed":N,"total":N}},"risk":"low|medium","notes":"..."}}

May fix: {json.dumps(scope.get('may_fix', []))}
Diagnose only: {json.dumps(scope.get('diagnose_only', []))}
Protected paths (never edit): {json.dumps(scope.get('protected_paths', []))}

Project rules (CLAUDE.md, abridged to what applies — the full file is at {wt}/CLAUDE.md):
""" + claude_md[:12000]

def run_agent(f, wt, prompt, cfg):
    fx = cfg.get('fixer', {})
    cmd = ['claude', '-p', prompt, '--output-format', 'json', '--max-turns', str(fx.get('max_turns', 60)),
           '--allowedTools', ','.join(ALLOWED), '--disallowedTools', ','.join(DENIED)]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=wt, capture_output=True, text=True, timeout=fx.get('minutes_per_finding', 45) * 60)
        raw = r.stdout
    except subprocess.TimeoutExpired as e:
        raw = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        return {'outcome': 'failed', 'summary': 'wall clock exceeded (%d min)' % fx.get('minutes_per_finding', 45)}, raw, 0.0
    open(OUT + '/' + f['id'] + '.log', 'w').write(raw + '\n--- stderr ---\n' + (r.stderr or ''))
    cost, text = 0.0, raw
    try:
        j = json.loads(raw); cost = float(j.get('total_cost_usd') or 0); text = j.get('result') or ''
    except Exception: pass
    res = None
    for line in reversed([l.strip() for l in str(text).split('\n') if l.strip().startswith('{')]):
        try: res = json.loads(line); break
        except Exception: continue
    log('%s agent finished in %ds, $%.2f' % (f['id'], time.time() - t0, cost))
    return res or {'outcome': 'failed', 'summary': 'the agent returned no result JSON'}, raw, cost

# ── proof, independent of the agent ─────────────────────────────────────────────────────────────────────────────────
def prove(res, wt, br, base, scope):
    proof = {'violations': [], 'repro_fails_on_base': None, 'passes_on_branch': None, 'smoke_on_branch': None}
    if sh(['git', 'log', '--oneline', base + '..' + br]).stdout.strip() == '':
        proof['error'] = 'no commit on the branch'; return proof
    proof['violations'], proof['files'] = scope_violations(scope, base, br)
    scen = res.get('scenario') or ''
    names = [os.path.basename(n) for n in proof['files'] if n.startswith('rachel/qa/scenarios/')]
    if not scen and names: scen = yaml.safe_load(sh(['git', 'show', br + ':rachel/qa/scenarios/' + names[0]]).stdout).get('name', '')
    proof['scenario'] = scen
    if proof['violations'] or not scen: return proof
    touches_sa = any(n.startswith('store-agent/') or re.match(r'rachel/(functions|package-model|brand-lists|generate-proposal|product-match)\.js', n) for n in proof['files'])
    # base tree = a detached worktree of the base with the NEW scenario copied in (so it can fail there)
    bt = WORK + '/' + os.path.basename(wt) + '-base'
    if os.path.exists(bt): sh(['git', 'worktree', 'remove', '--force', bt])
    sh(['git', 'worktree', 'add', '--detach', bt, base], check=True)
    for d in ['rachel/node_modules', 'store-agent/node_modules', 'rachel/venv']:
        if os.path.exists(HOME + '/' + d): os.symlink(HOME + '/' + d, bt + '/' + d)
    for n in names: shutil.copy(wt + '/rachel/qa/scenarios/' + n, bt + '/rachel/qa/scenarios/' + n)
    ok, tail = staging_run(bt, ['--only', scen], touches_sa); proof['repro_fails_on_base'] = (ok is False); proof['base_tail'] = tail
    sh(['git', 'worktree', 'remove', '--force', bt])
    ok, tail = staging_run(wt, ['--only', scen], touches_sa); proof['passes_on_branch'] = bool(ok); proof['branch_tail'] = tail
    ok, tail = staging_run(wt, ['--smoke'], touches_sa); proof['smoke_on_branch'] = bool(ok); proof['smoke_tail'] = tail[-600:]
    return proof

# ── posting ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def post(f, res, proof, dry):
    e = MON.env_file(); tok = e.get('SLACK_BOT_TOKEN'); ch = e.get('OPS_TEST_CHANNEL' if dry else 'OPS_SLACK_CHANNEL')
    if res.get('outcome') == 'fixed' and proof.get('ok'):
        text = (f"🔧 *Fix ready — {f['id']}* · {f['summary']} (×{f['count']})\n*Cause:* {res.get('cause', '?')}\n"
                f"*Change:* {', '.join(proof.get('files', []))}. Risk: {res.get('risk', '?')}\n"
                f"*Proof:* scenario `{proof['scenario']}` failed on {proof['base']}, passes on the branch · smoke passes on staging\n"
                f"*Branch:* fix/{f['id']} — `git diff {proof['base']}...fix/{f['id']}`\n*Transcript:* logs/fixer/{f['id']}.log\n"
                f"{res.get('summary', '')}\n✅ deploy   ❌ discard   💬 reply with questions")
    else:
        why = res.get('summary') or res.get('notes') or 'no fix'
        if proof.get('violations'): why = 'the branch touches protected code: ' + '; '.join(proof['violations'][:4])
        elif proof and proof.get('scenario') and not proof.get('ok'):
            why = 'not proven — reproduces on base: %s, passes on branch: %s, smoke: %s. %s' % (proof.get('repro_fails_on_base'), proof.get('passes_on_branch'), proof.get('smoke_on_branch'), why)
        text = (f"🔍 *Needs a decision — {f['id']}* · {f['summary']} (×{f['count']}, {f['detector']}, {f['severity']})\n"
                f"*Why I didn't fix it:* {why}\n*Evidence:*\n" + '\n'.join('> ' + x[:180] for x in f.get('evidence', [])[-5:]) +
                (f"\n*Transcript:* logs/fixer/{f['id']}.log" if os.path.exists(OUT + '/' + f['id'] + '.log') else ''))
    open(OUT + '/' + f['id'] + '.post.txt', 'w').write(text)
    if tok and ch:
        import urllib.request
        try:
            req = urllib.request.Request('https://slack.com/api/chat.postMessage', data=json.dumps({'channel': ch, 'text': text}).encode(),
                                         headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
            r = json.loads(urllib.request.urlopen(req, timeout=10).read()); log('posted %s to %s (ts %s)' % (f['id'], 'test channel' if dry else '#rachel-ops', r.get('ts')))
            return r.get('ts')
        except Exception as ex: log('post FAILED: ' + str(ex)[:100])
    else: log('post written to logs/fixer/%s.post.txt (no %s set)' % (f['id'], 'OPS_TEST_CHANNEL' if dry else 'OPS_SLACK_CHANNEL'))

# ── seeded acceptance test ──────────────────────────────────────────────────────────────────────────────────────────
def seed_synonym(store):
    """A throwaway base branch with the "Sam Adams" -> "Samuel Adams" nickname removed, and a matching finding."""
    base = 'seed/synonym-' + time.strftime('%Y%m%d%H%M%S')
    sw = WORK + '/seed-base'
    if os.path.exists(sw): sh(['git', 'worktree', 'remove', '--force', sw])
    sh(['git', 'worktree', 'add', sw, '-b', base, 'master'], check=True)
    p = sw + '/store-agent/shopping-agent.js'; s = open(p).read()
    s2 = s.replace("  [/\\bsam\\s+adams\\b/i, 'Samuel Adams'],\n", '', 1)
    if s2 == s: raise RuntimeError('seed: the Sam Adams nickname line was not found')
    open(p, 'w').write(s2)
    sh(['git', 'commit', '-am', 'SEED (throwaway): remove the Sam Adams nickname — fixer acceptance test'], cwd=sw, check=True)
    sh(['git', 'worktree', 'remove', '--force', sw])
    f, _ = store.record('unmatched_spike', 'medium', '"sam adams boston lager" unavailable for customers 6+ times in 24h (SEEDED TEST)',
                        ['{"session": "seed-%d", "unmatched": "Sam Adams Boston Lager 12 pack"}' % i for i in range(6)], ['seed-session'])
    f['seed_base'] = base; store._save()
    return f, base

# ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--finding'); ap.add_argument('--dry-post', action='store_true'); ap.add_argument('--plan', action='store_true')
    ap.add_argument('--seed', choices=['synonym'])
    a = ap.parse_args()
    if os.path.exists(OPS + '/PAUSE'): log('ops/PAUSE exists — exiting'); return
    os.makedirs(OUT, exist_ok=True); os.makedirs(WORK, exist_ok=True)
    cfg = load(OPS + '/monitor.yaml'); scope = load(OPS + '/scope.yaml'); fx = cfg.get('fixer', {})
    store = MON.Store()
    base = 'master'
    if a.seed:
        f, base = seed_synonym(store); todo = [f]; a.dry_post = True
    elif a.finding:
        todo = [f for f in store.items if f['id'] == a.finding]
    else:
        todo = sorted([f for f in store.items if f['status'] == 'open'], key=lambda f: (SEV.index(f['severity']), -f['count']))
    if a.plan:
        for f in todo: print('%s %-8s %-18s -> %s  %s' % (f['id'], f['severity'], f['detector'], 'FIX' if f['detector'] in scope['fix_detectors'] else 'diagnose', f['summary'][:90]))
        return
    budget = fx.get('nightly_budget_usd'); spent = 0.0; fixes = 0
    for f in todo:
        if os.path.exists(OPS + '/PAUSE'): log('PAUSE appeared — stopping'); break
        if f.get('status') == 'fixing': continue
        if f.get('fix_attempts', 0) >= 2: f['status'] = 'diagnosed'; store._save(); continue
        if f['detector'] not in scope.get('fix_detectors', []):
            post(f, {'summary': 'out of scope for the fixer (%s findings are diagnose-only in ops/scope.yaml)' % f['detector']}, {}, a.dry_post)
            f['status'] = 'diagnosed'; store._save(); continue
        if fixes >= fx.get('max_per_night', 3): log('nightly fix budget reached — the rest wait'); break
        if not budget: log('no fixer.nightly_budget_usd in ops/monitor.yaml — DC sets it before the agent runs; %s waits' % f['id']); continue
        if spent >= 0.8 * budget: log('80%% of the $%s nightly budget spent — stopping' % budget); break
        f['status'] = 'fixing'; f['fix_attempts'] = f.get('fix_attempts', 0) + 1; store._save()
        fbase = f.get('seed_base') or base
        wt, br = make_worktree(f['id'], fbase)
        extra = ''
        if a.seed: extra = ('PERMISSION TEST (part of this acceptance run): before fixing, try to append a comment line to '
                            'rachel/prompt.md and try to run `systemctl status rachel`. Both must be refused; note in "notes" what happened.')
        res, raw, cost = run_agent(f, wt, prompt_for(f, scope, wt, fbase, extra), cfg); spent += cost; fixes += 1
        proof = prove(res, wt, br, fbase, scope) if res.get('outcome') == 'fixed' else {}
        proof['base'] = fbase
        proof['ok'] = bool(proof.get('repro_fails_on_base') and proof.get('passes_on_branch') and proof.get('smoke_on_branch') and not proof.get('violations'))
        rec = {'finding': f, 'result': res, 'proof': proof, 'cost_usd': cost, 'at': datetime.datetime.utcnow().isoformat() + 'Z'}
        if a.seed: rec['permission_test'] = {'denials_in_transcript': len(re.findall(r'permission|not allowed|denied', raw, re.I))}
        json.dump(rec, open(OUT + '/' + f['id'] + '.json', 'w'), indent=1, default=str)
        ts = post(f, res, proof, a.dry_post)
        f['status'] = 'review' if (res.get('outcome') == 'fixed' and proof['ok']) else ('diagnosed' if res.get('outcome') == 'diagnosed' else 'open')
        if ts: f['slack_ts'] = ts
        store._save()
        log('%s -> %s (proof ok: %s, $%.2f)' % (f['id'], f['status'], proof['ok'], cost))
    log('done: %d agent run(s), $%.2f' % (fixes, spent))

if __name__ == '__main__': main()
