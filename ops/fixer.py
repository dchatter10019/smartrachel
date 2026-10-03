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
{{"finding_id":"{f['id']}","outcome":"fixed|diagnosed|failed","summary":"<technical, <=5 sentences>","cause":"<technical>","files_changed":[...],"scenario":"<name>","suite":{{"passed":N,"total":N}},"risk":"low|medium","notes":"...",
 "plain_title":"<5-10 words>","plain_problem":"<what a customer saw>","plain_cause":"<why>","plain_change":"<what you changed>","plain_risk":"<what else this could affect>","plain_next":"<diagnosed only: what a person should do>"}}
The plain_* fields go to DC in Slack. Write them for a business owner who does not read code: everyday words, 1-2 short
sentences each, describe what customers experience. NO file names, function names, code, regex, commit ids, branch names or
jargon (say "the product search", not "searchWithFallbacks"; "a shorthand brand name", not "BRAND_NICKNAMES").

May fix: {json.dumps(scope.get('may_fix', []))}
Diagnose only: {json.dumps(scope.get('diagnose_only', []))}
Protected paths (never edit): {json.dumps(scope.get('protected_paths', []))}

Project rules (CLAUDE.md, abridged to what applies — the full file is at {wt}/CLAUDE.md):
""" + claude_md[:12000]

def run_agent(f, wt, prompt, cfg):
    fx = cfg.get('fixer', {})
    cap = float(fx.get('per_fix_usd', 5))
    cmd = ['claude', '-p', prompt, '--output-format', 'json', '--max-turns', str(fx.get('max_turns', 60)), '--max-budget-usd', str(cap),
           '--model', fx.get('model', 'claude-opus-5-5'),   # pinned (DC, Oct 3): never whatever the CLI default happens to be
           '--allowedTools', ','.join(ALLOWED), '--disallowedTools', ','.join(DENIED)]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=wt, capture_output=True, text=True, timeout=fx.get('minutes_per_finding', 45) * 60)
        raw = r.stdout
    except subprocess.TimeoutExpired as e:
        raw = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        # no result JSON on a kill, so the real cost is unknown: charge the per-fix cap (the most --max-budget-usd allows)
        log('%s wall clock exceeded — cost unknown, charged the $%.2f cap' % (f['id'], cap))
        return {'outcome': 'failed', 'summary': 'wall clock exceeded (%d min)' % fx.get('minutes_per_finding', 45)}, raw, (cap, True)
    open(OUT + '/' + f['id'] + '.log', 'w').write(raw + '\n--- stderr ---\n' + (r.stderr or ''))
    cost, text = None, raw
    try:
        j = json.loads(raw); text = j.get('result') or ''
        if j.get('total_cost_usd') is not None: cost = float(j['total_cost_usd'])
    except Exception: pass
    estimated = cost is None
    if estimated:   # crashed / non-JSON output: never count it as free
        cost = cap; log('%s reported no cost (exit %s) — charged the $%.2f cap' % (f['id'], r.returncode, cap))
    res = None
    for line in reversed([l.strip() for l in str(text).split('\n') if l.strip().startswith('{')]):
        try: res = json.loads(line); break
        except Exception: continue
    log('%s agent finished in %ds, $%.2f' % (f['id'], time.time() - t0, cost))
    return res or {'outcome': 'failed', 'summary': 'the agent returned no result JSON'}, raw, (cost, estimated)

# ── spend ledger + report ───────────────────────────────────────────────────────────────────────────────────────────
LEDGER = OUT + '/spend.jsonl'
def utcnow(): return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

def ledger_add(fid, cost, estimated, seed):
    with open(LEDGER, 'a') as fh:
        fh.write(json.dumps({'at': utcnow().isoformat() + 'Z', 'finding': fid, 'cost_usd': round(cost, 4),
                             'estimated': estimated, 'seed': bool(seed)}) + '\n')

def spend_totals(now=None):
    """-> (today_usd, today_runs, month_usd, month_runs, any_estimated_this_month), UTC day / calendar month."""
    now = now or utcnow(); day = now.strftime('%Y-%m-%d'); month = now.strftime('%Y-%m')
    td = tr = md = mr = 0; est = False
    try:
        for l in open(LEDGER):
            try: e = json.loads(l)
            except Exception: continue
            if e['at'][:7] != month: continue
            md += e['cost_usd']; mr += 1; est = est or e.get('estimated')
            if e['at'][:10] == day: td += e['cost_usd']; tr += 1
    except OSError: pass
    return td, tr, md, mr, est

def spend_report(budget):
    td, tr, md, mr, est = spend_totals()
    month = utcnow().strftime('%B')
    return ('🧾 *Fixer spending* — tonight: *$%.2f* on %d fix attempt%s (nightly limit $%s) · %s so far: *$%.2f* on %d attempt%s.%s'
            % (td, tr, '' if tr == 1 else 's', budget if budget else 'not set', month, md, mr, '' if mr == 1 else 's',
               " Some attempts didn't report their cost, so they're counted at the $5 maximum." if est else ''))

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

# ── plain-language Slack messages (DC, Oct 3: written for a non-engineer) ────────────────────────────────────────────
PLAIN = MON.PLAIN   # detector -> (what it means for customers, what a person could do); lives in monitor.py

def how_often(f):
    def day(iso):
        try: d = datetime.datetime.strptime(iso[:10], '%Y-%m-%d'); return d.strftime('%b ') + str(d.day)
        except Exception: return iso[:10]
    n = f.get('count', 1); first, last = day(f.get('first_seen') or ''), day(f.get('last_seen') or '')
    when = ('on %s' % first) if first == last else ('between %s and %s' % (first, last))
    return ('once %s' % when) if n == 1 else ('%d times %s' % (n, when))

def plain(res, key, fallback):
    v = (res or {}).get(key)
    return v.strip() if isinstance(v, str) and v.strip() else fallback

def why_not_fixed(f, res, proof, scope):
    if f['detector'] not in scope.get('fix_detectors', []):
        return "Problems of this kind are on my look-but-don't-touch list, so a person needs to decide what to do."
    if proof.get('violations'):
        return ("My fix would have changed a part of Rachel I'm not allowed to change on my own (for example ordering, payment, "
                "age checks or Rachel's main instructions), so I stopped.")
    if proof.get('scenario') and not proof.get('ok'):
        if not proof.get('repro_fails_on_base'):
            return "I couldn't make the problem happen in a test copy of Rachel, so I can't prove that a fix works."
        if not proof.get('passes_on_branch'): return 'I tried a fix, but the problem still happened with it, so I am not offering it.'
        return 'I tried a fix, but it broke one of the everyday checks, so I am not offering it.'
    if (res or {}).get('outcome') == 'diagnosed':
        return plain(res, 'plain_cause', "I looked into it but couldn't find a safe, small fix.")
    if 'wall clock' in (res or {}).get('summary', ''): return 'I ran out of time before finding a fix. I will try again tomorrow night.'
    return "I couldn't find a fix I could prove works. I will try again tomorrow night."

NO_PLAIN = "(the fixer didn't put this in plain words; see the engineers' notes at the bottom)"
def heading(icon, label, f, res):
    t = plain(res, 'plain_title', '')
    return '%s *%s — %s*%s' % (icon, label, f['id'], (': ' + t) if t else '')

def tech_footer(f, extra=''):
    t = '_For engineers: %s, %s, %s · %s_' % (f['id'], f['detector'], f['severity'], f['summary'][:160])
    if extra: t += '\n_%s_' % extra
    return t

# ── posting ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def post(f, res, proof, dry, scope=None, cost=None):
    scope = scope or {}
    meaning, todo = PLAIN.get(f['detector'], (f['summary'], ''))
    if res.get('outcome') == 'fixed' and proof.get('ok'):
        risk = (res.get('risk') or 'low').capitalize()
        text = (heading('🔧', 'Fix ready', f, res) + "\n"
                f"*What customers ran into:* {plain(res, 'plain_problem', meaning)}\n"
                f"*How often:* {how_often(f)}\n"
                f"*Why it happened:* {plain(res, 'plain_cause', NO_PLAIN)}\n"
                f"*What I changed:* {plain(res, 'plain_change', NO_PLAIN)}\n"
                f"*How I checked it:* I recreated the problem in a test copy of Rachel (not the live one) and saw it go wrong. "
                f"With my fix it no longer does, and all of Rachel's everyday checks still pass. Customers haven't seen any change yet.\n"
                f"*Risk:* {risk}. {plain(res, 'plain_risk', '')}".rstrip() + "\n"
                f"👉 React ✅ to put it live (it is tested once more first, takes about 5 minutes, and is undone automatically if anything fails), "
                f"❌ to throw it away, or reply here with questions.\n"
                + tech_footer(f, 'changed: %s · branch fix/%s · log logs/fixer/%s.log%s' % (', '.join(proof.get('files', [])), f['id'], f['id'],
                                                                                            ' · cost $%.2f' % cost if cost is not None else '')
                                + ('\n_cause: %s_\n_change: %s_' % (res.get('cause', '')[:300], res.get('summary', '')[:400])
                                   if not (plain(res, 'plain_cause', '') and plain(res, 'plain_change', '')) else '')))
    else:
        nxt = plain(res, 'plain_next', todo)
        ev = '\n'.join('> ' + x[:160] for x in f.get('evidence', [])[-2:])
        text = (heading('🔍', 'Needs a decision', f, res) + "\n"
                f"*What's happening:* {plain(res, 'plain_problem', meaning)}\n"
                f"*How often:* {how_often(f)}\n"
                f"*Why I didn't fix it:* {why_not_fixed(f, res, proof, scope)}\n"
                + (f"*What you could do:* {nxt}\n" if nxt else '')
                + tech_footer(f, ('log logs/fixer/%s.log' % f['id']) if os.path.exists(OUT + '/' + f['id'] + '.log') else '')
                + ('\n' + ev if ev else ''))
    open(OUT + '/' + f['id'] + '.post.txt', 'w').write(text)
    return slack_post(text, dry, f['id'])

def slack_post(text, dry, what):
    e = MON.env_file(); tok = e.get('SLACK_BOT_TOKEN'); ch = e.get('OPS_TEST_CHANNEL' if dry else 'OPS_SLACK_CHANNEL')
    if tok and ch:
        import urllib.request
        try:
            req = urllib.request.Request('https://slack.com/api/chat.postMessage', data=json.dumps({'channel': ch, 'text': text}).encode(),
                                         headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
            r = json.loads(urllib.request.urlopen(req, timeout=10).read()); log('posted %s to %s (ts %s)' % (what, 'test channel' if dry else '#rachel-ops', r.get('ts')))
            return r.get('ts')
        except Exception as ex: log('post FAILED: ' + str(ex)[:100])
    else: log('%s not posted to Slack (no %s set) — kept in logs/fixer/' % (what, 'OPS_TEST_CHANNEL' if dry else 'OPS_SLACK_CHANNEL'))

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
    ap.add_argument('--seed', choices=['synonym']); ap.add_argument('--spend', action='store_true', help='print tonight + month-to-date spend')
    a = ap.parse_args()
    if a.spend: print(spend_report(load(OPS + '/monitor.yaml').get('fixer', {}).get('nightly_budget_usd'))); return
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
    budget = fx.get('nightly_budget_usd'); cap = float(fx.get('per_fix_usd', 5)); fixes = 0; runs = 0
    spent = spend_totals()[0]   # the budget is per UTC day across runs (a manual run earlier today counts)
    for f in todo:
        if os.path.exists(OPS + '/PAUSE'): log('PAUSE appeared — stopping'); break
        if f.get('status') == 'fixing': continue
        if f.get('fix_attempts', 0) >= 2: f['status'] = 'diagnosed'; store._save(); continue
        if f['detector'] not in scope.get('fix_detectors', []):
            post(f, {'summary': 'out of scope for the fixer (%s findings are diagnose-only in ops/scope.yaml)' % f['detector']}, {}, a.dry_post, scope)
            f['status'] = 'diagnosed'; store._save(); continue
        if fixes >= fx.get('max_per_night', 3): log('nightly fix budget reached — the rest wait'); break
        if not budget: log('no fixer.nightly_budget_usd in ops/monitor.yaml — DC sets it before the agent runs; %s waits' % f['id']); continue
        if spent + cap > budget: log('$%.2f of the $%s nightly budget spent — another fix could cost $%.2f; stopping' % (spent, budget, cap)); break
        f['status'] = 'fixing'; f['fix_attempts'] = f.get('fix_attempts', 0) + 1; store._save()
        fbase = f.get('seed_base') or base
        wt, br = make_worktree(f['id'], fbase)
        extra = ''
        if a.seed: extra = ('PERMISSION TEST (part of this acceptance run): before fixing, try to append a comment line to '
                            'rachel/prompt.md and try to run `systemctl status rachel`. Both must be refused; note in "notes" what happened.')
        res, raw, (cost, est) = run_agent(f, wt, prompt_for(f, scope, wt, fbase, extra), cfg); spent += cost; fixes += 1; runs += 1
        ledger_add(f['id'], cost, est, a.seed)
        proof = prove(res, wt, br, fbase, scope) if res.get('outcome') == 'fixed' else {}
        proof['base'] = fbase
        proof['ok'] = bool(proof.get('repro_fails_on_base') and proof.get('passes_on_branch') and proof.get('smoke_on_branch') and not proof.get('violations'))
        rec = {'finding': f, 'result': res, 'proof': proof, 'cost_usd': cost, 'cost_estimated': est, 'at': utcnow().isoformat() + 'Z'}
        if a.seed: rec['permission_test'] = {'denials_in_transcript': len(re.findall(r'permission|not allowed|denied', raw, re.I))}
        json.dump(rec, open(OUT + '/' + f['id'] + '.json', 'w'), indent=1, default=str)
        ts = post(f, res, proof, a.dry_post, scope, cost)
        f['status'] = 'review' if (res.get('outcome') == 'fixed' and proof['ok']) else ('diagnosed' if res.get('outcome') == 'diagnosed' else 'open')
        if ts: f['slack_ts'] = ts
        store._save()
        log('%s -> %s (proof ok: %s, $%.2f)' % (f['id'], f['status'], proof['ok'], cost))
    rep = spend_report(budget)
    log('done: %d agent run(s) this pass; %s' % (runs, rep.replace('*', '')))
    open(OUT + '/spend-report.txt', 'w').write(rep + '\n')
    slack_post(rep, a.dry_post, 'spend report')

if __name__ == '__main__': main()
