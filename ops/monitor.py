#!/usr/bin/env python3
"""Rachel monitor — Debug-and-Fix Loop spec, Part A. Pure detection: tails the logs, the event stream, the QA results
and the services' state, and appends a FINDING to logs/findings.jsonl when a detector trips. It never edits, restarts
or messages customers. Thresholds: ops/monitor.yaml.

  ops/monitor.py                 run forever (the rachel-monitor service)
  ops/monitor.py --once          one pass over what is new since the last pass, then exit
  ops/monitor.py --status        open findings
  ops/monitor.py --replay FILE   run the detectors over an old log (or events.jsonl) to tune thresholds; writes nothing

QA traffic: crashes and API errors count from any session (they are the code's, not the customer's); the customer-facing
detectors (slow turns, latency, unavailable products, stuck sessions, escalations) skip QA sessions (« qa-… » tags,
events with qa:true) — QA exercises edge cases on purpose.
Finding: {id, ts, detector, severity, summary, evidence[], sessions[], count, first_seen, last_seen, status}
Status: open -> fixing -> review -> deployed | diagnosed | discarded | expired. Evidence: max 40 lines, phone numbers,
tokens and webhook URLs redacted.
"""
import argparse, collections, glob, json, os, re, statistics, subprocess, sys, time, urllib.request
import yaml

HOME = '/home/ubuntu'
LOGS = HOME + '/logs'
CFG_FILE = HOME + '/ops/monitor.yaml'
FINDINGS = LOGS + '/findings.jsonl'
STATE = LOGS + '/monitor-state.json'
TEXT_LOGS = {   # source -> path; lines have no timestamp unless the format gives one (then it is parsed)
    'rachel': LOGS + '/rachel.log', 'shopping-agent': LOGS + '/shopping-agent.log', 'slack': LOGS + '/slack-rachel.log',
    'whatsapp': LOGS + '/rachel-whatsapp.log', 'email': LOGS + '/email-agent.log', 'watchdog': LOGS + '/watchdog.log',
}
EVENTS = LOGS + '/events.jsonl'
FEEDBACK = LOGS + '/feedback.jsonl'   # corrections, 'Rachel feedback:' lines, Slack 👎 (rachel/feedback.js, rachel_slack_bot.py)
REVIEW_ISSUES = LOGS + '/review-issues.jsonl'   # nightly conversation review (ops/conversation-review.py, Oct 7)
SIDE_TESTS = LOGS + '/side-tests.jsonl'   # nightly side tests (connector, monitor self-test) — rachel/qa/nightly.sh
QA_RUNS = HOME + '/rachel/qa/runs'

def log(msg): print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + ' [monitor] ' + msg, flush=True)

# ── redaction (evidence never carries secrets or full phone numbers) ────────────────────────────────────────────────
RED = [(re.compile(r'https://hooks\.slack\.com/\S+'), 'https://hooks.slack.com/<redacted>'),
       (re.compile(r'\b(xox[abpr]-[\w-]+|sk-ant-[\w-]+|AIza[\w-]{20,})'), '<redacted-token>'),
       (re.compile(r'(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?(\d{4})(?!\d)'), r'***-***-\1')]   # also "+15550001234" (WhatsApp ids)
def redact(s):
    s = str(s)
    for r, w in RED: s = r.sub(w, s)
    return s[:400]

QA_TAG = re.compile(r'«\s*(qa-[^»]*?)\s*»\s*$')
ANY_TAG = re.compile(r'«\s*([^»]+?)\s*»\s*$')
def session_of(line):
    m = ANY_TAG.search(line); return m.group(1) if m else ''
def is_qa(line): return bool(QA_TAG.search(line)) or 'rachel_qa@' in line or 'qa-whatsapp@' in line

# ── findings store ──────────────────────────────────────────────────────────────────────────────────────────────────
class Store:
    def __init__(self, path=FINDINGS, dedupe_days=7, evidence_cap=40, dry=False):
        self.path, self.dedupe, self.cap, self.dry = path, dedupe_days * 86400, evidence_cap, dry
        self.items = self._read()
        self._snap = {f['id']: self._sig(f) for f in self.items}   # each item as last synced with the file
        self.new = []
    @staticmethod
    def _sig(f): return json.dumps(f, sort_keys=True, default=str)
    def _read(self):
        out = []
        if os.path.exists(self.path):
            for l in open(self.path):
                try: out.append(json.loads(l))
                except Exception: pass
        return out
    def _merge(self, disk):
        # An item THIS process changed since it last synced wins; every other item takes the file's version (updated in
        # place, so callers holding a finding keep a live reference). Before Oct 3 our whole stale copy won: the long-running
        # monitor's next save reverted every status the fixer, deploy-fix.sh or the Slack ❌ handler had written.
        mine = {f['id']: f for f in self.items}; merged = []
        for d in disk:
            m = mine.pop(d['id'], None)
            if m is not None and self._sig(m) != self._snap.get(d['id']): merged.append(m)
            elif m is not None: m.clear(); m.update(d); merged.append(m)
            else: merged.append(d)
        self.items = merged + list(mine.values())
        self._snap = {f['id']: self._sig(f) for f in self.items}
    def refresh(self):
        """Pull in what other processes wrote (keeps our own unsaved changes)."""
        if self.dry: return
        import fcntl
        with open(self.path + '.lock', 'w') as lk:
            fcntl.flock(lk, fcntl.LOCK_EX); self._merge(self._read())
    def key(self, detector, summary): return detector + '|' + re.sub(r'\d+', '#', summary.lower())[:160]
    def record(self, detector, severity, summary, evidence, sessions=(), now=None):
        now = now or time.time(); k = self.key(detector, summary)
        self.refresh()   # a finding resolved/diagnosed elsewhere must not be matched (or re-opened) from a stale copy
        for f in self.items:
            if f.get('key') == k and f['status'] in ('open', 'fixing', 'review', 'diagnosed') and now - f['last_seen_t'] < self.dedupe:
                f['count'] += 1; f['last_seen_t'] = now; f['last_seen'] = iso(now)
                f['evidence'] = (f['evidence'] + [redact(e) for e in evidence])[-self.cap:]
                f['sessions'] = sorted(set(f['sessions']) | set(s for s in sessions if s))[:20]
                self._save(); return f, False
        f = {'id': 'F-%04d' % (len(self.items) + 1), 'key': k, 'ts': iso(now), 'detector': detector, 'severity': severity,
             'summary': redact(summary), 'evidence': [redact(e) for e in evidence][-self.cap:], 'sessions': sorted(set(s for s in sessions if s))[:20],
             'count': 1, 'first_seen': iso(now), 'last_seen': iso(now), 'last_seen_t': now, 'status': 'open'}
        self.items.append(f); self.new.append(f); self._save(); return f, True
    def _save(self):
        # The monitor service, the fixer, deploy-fix.sh and the Slack bot all write this file: lock, re-read, merge (_merge), write.
        if self.dry: return
        import fcntl
        with open(self.path + '.lock', 'w') as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            self._merge(self._read())
            tmp = self.path + '.tmp'
            with open(tmp, 'w') as fh:
                for f in self.items: fh.write(json.dumps(f) + '\n')
            os.replace(tmp, self.path)
    def expire(self, now=None):
        now = now or time.time(); self.refresh()
        for f in self.items:
            if f['status'] == 'open' and now - f['last_seen_t'] > self.dedupe: f['status'] = 'expired'
        self._save()

def iso(t): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))

# ── detectors ───────────────────────────────────────────────────────────────────────────────────────────────────────
CRASH = re.compile(r'\b(?:TypeError|ReferenceError|SyntaxError|RangeError): |Unhandled(?: promise)? rejection|UnhandledPromiseRejection|Traceback \(most recent call last\)|FATAL ERROR')
UPSTREAM = re.compile(r'\[searchProducts\] HTTP 5\d\d|catalog unreachable|CATALOG_UNREACHABLE|non-JSON response|createCorpOrder (?:failed|HTTP 5)|\[gbrain\] error: fetch failed')
LLM_ERR = re.compile(r'fetch failed\(retried\)|overloaded_error|rate_limit_error|\b529\b|api_error|\[rachel\] (?:API|anthropic) error', re.I)
RESOLVER = re.compile(r'could not resolve|couldn\'t match', re.I)
CHAT = re.compile(r'\[rachel\] chat — session: (\S+) messages: \d+ — "(.*)$')
ESCAL = re.compile(r'\b(?:talk|speak|chat) (?:to|with) (?:a |an |someone|somebody)?\s*(?:human|real person|person|agent|representative|someone|manager)\b|\breal person\b|\bcustomer (?:service|support) (?:rep|agent)\b', re.I)
WATCHDOG = re.compile(r'ISSUES FOUND: (.+)')

class Monitor:
    def __init__(self, cfg, store, now_fn=time.time):
        self.cfg, self.store, self.now = cfg, store, now_fn
        d = cfg['detectors']; self.d = d
        self.win = collections.defaultdict(collections.deque)   # detector key -> deque[(t, evidence, session)]
        self.lat = collections.defaultdict(collections.deque)   # channel -> deque[(t, seconds)]
        self.sess_state = collections.defaultdict(list)          # session -> [state_out...]
        self.sess_msgs = collections.defaultdict(list)           # session -> [message...]
        self.svc_seen = {}

    def _window(self, key, t, ev, sess, span_s, need):
        q = self.win[key]; q.append((t, ev, sess))
        while q and t - q[0][0] > span_s: q.popleft()
        return len(q) >= need, q

    def text_line(self, source, line, t=None):
        t = t or self.now(); d = self.d; sess = session_of(line); qa = is_qa(line)
        if CRASH.search(line):
            # the same crash in different sessions is ONE finding: the summary has no session tag
            self.store.record('crash', d['crash']['severity'], source + ': ' + ANY_TAG.sub('', line).strip()[:140], [source + ': ' + line.strip()], [sess], t)
            return
        if '[stuck-turn]' in line:   # a hung turn: no reply, no event — a code bug whoever's session it is
            self.store.record('stuck_turn', d.get('stuck_turn', {}).get('severity', 'high'), source + ': a turn hung with no reply (' + ('QA' if qa else 'customer') + ')',
                              [line.strip()], [sess or (re.search(r'\[stuck-turn\] (\S+)', line) or [None, ''])[1]], t)
            return
        if UPSTREAM.search(line):
            what = 'gbrain unreachable' if 'gbrain' in line else 'Bevvi API ' + (re.search(r'HTTP 5\d\d', line).group(0) if re.search(r'HTTP 5\d\d', line) else 'unreachable')
            hit, q = self._window('upstream|' + what, t, source + ': ' + line.strip(), sess, d['upstream_error']['window_minutes'] * 60, d['upstream_error']['count'])
            if hit: self.store.record('upstream_error', d['upstream_error']['severity'], what + ': %d+ in %d min' % (len(q), d['upstream_error']['window_minutes']), [e for _, e, _ in q], [s for _, _, s in q], t); q.clear()
        if LLM_ERR.search(line):
            hit, q = self._window('llm', t, source + ': ' + line.strip(), sess, d['llm_error']['window_minutes'] * 60, d['llm_error']['count'])
            if hit: self.store.record('llm_error', d['llm_error']['severity'], 'Anthropic API errors: %d+ in %d min' % (len(q), d['llm_error']['window_minutes']), [e for _, e, _ in q], [s for _, _, s in q], t); q.clear()
        if source == 'watchdog':
            m = WATCHDOG.search(line)
            if m: self.store.record('watchdog_alert', d['watchdog_alert']['severity'], 'nightly watchdog: ' + m.group(1).strip(), [line.strip()], [], t)
            return
        # Below: customer-facing only. Only QA sessions are tagged («qa-…»), so an untagged line is a customer's — except
        # where tagging is lost; chat lines carry their session id, so QA is decided from it.
        m = CHAT.search(line)
        if m:
            s_id, msg = m.group(1), m.group(2).strip().rstrip('"').strip().lower()
            if re.match(r'qa-', s_id) or 'rachel_qa' in s_id or 'qa-whatsapp' in s_id: return
            if ESCAL.search(msg):
                self.store.record('escalation_request', d['escalation_request']['severity'], 'customer asked for a human (' + s_id + ')', [line.strip()], [s_id], t)
            msgs = self.sess_msgs[s_id]; msgs.append(msg); del msgs[:-6]
            n = d['stuck_session']['repeat_message']
            if msg and len(msg) > 3 and len(msgs) >= n and all(x == msg for x in msgs[-n:]):
                self.store.record('stuck_session', d['stuck_session']['severity'], 'customer repeated the same message %dx (%s)' % (n, s_id), [line.strip()], [s_id], t)
            return
        if qa: return
        if RESOLVER.search(line):
            hit, q = self._window('resolver', t, line.strip(), sess, d['resolver_miss']['window_hours'] * 3600, d['resolver_miss']['count'])
            if hit: self.store.record('resolver_miss', d['resolver_miss']['severity'], 'resolver misses: %d+ in %dh' % (len(q), d['resolver_miss']['window_hours']), [e for _, e, _ in q], [s for _, _, s in q], t); q.clear()

    def event(self, e, t=None):
        t = t or self.now(); d = self.d
        if e.get('qa'): return
        sess, ch, lat = e.get('session', ''), e.get('channel', '?'), (e.get('latency_ms') or 0) / 1000.0
        if lat > d['slow_turn']['seconds']:
            self.store.record('slow_turn', d['slow_turn']['severity'], 'a %s turn took %ds' % (ch, lat), [json.dumps(e)[:300]], [sess], t)
        if lat:
            q = self.lat[ch]; q.append((t, lat))
            while q and t - q[0][0] > d['latency']['window_minutes'] * 60: q.popleft()
            if len(q) >= d['latency']['min_turns']:
                med = statistics.median(x for _, x in q)
                if med > d['latency']['median_seconds']:
                    self.store.record('latency', d['latency']['severity'], '%s median reply %.0fs over the last %d min (%d turns)' % (ch, med, d['latency']['window_minutes'], len(q)), ['median %.1fs' % med], [sess], t); q.clear()
        # Unavailable products from the event stream (reliable qa flag; untagged log lines are not)
        for prod in (e.get('unmatched') or []):
            prod = str(prod).strip().lower()
            if not prod: continue
            hit, q = self._window('unavail|' + prod, t, json.dumps({'session': sess, 'unmatched': prod}), sess, d['unmatched_spike']['window_hours'] * 3600, d['unmatched_spike']['count'])
            if hit: self.store.record('unmatched_spike', d['unmatched_spike']['severity'], '"%s" unavailable for customers %d+ times in %dh' % (prod, len(q), d['unmatched_spike']['window_hours']), [ev for _, ev, _ in q], [s2 for _, _, s2 in q], t); q.clear()
        so = e.get('state_out') or ''
        st = self.sess_state[sess]; st.append(so); del st[:-8]
        n = d['stuck_session']['same_state_turns']
        if so and so != 'ready' and len(st) >= n and all(x == so for x in st[-n:]):
            self.store.record('stuck_session', d['stuck_session']['severity'], 'session stuck in "%s" for %d turns (%s)' % (so, n, sess), [json.dumps(e)[:300]], [sess], t); st.clear()

    def feedback(self, e, t=None):
        # A person told Rachel she got something wrong (DC, Oct 3). One finding per conversation (repeats count up).
        if e.get('qa'): return
        kinds = {'correction': 'customer corrected Rachel', 'unhappy': 'customer unhappy with Rachel', 'feedback': 'feedback about Rachel', 'thumbs_down': '👎 on a Rachel reply'}
        sess = e.get('session', '')
        ev = '%s | %s said: %s | Rachel had said: %s' % (e.get('kind'), e.get('who', '?'), str(e.get('text', ''))[:300], str(e.get('rachel_said', ''))[:600].replace('\n', ' / '))
        self.store.record('feedback', self.d.get('feedback', {}).get('severity', 'high'), '%s (%s)' % (kinds.get(e.get('kind'), 'feedback'), sess), [ev], [sess], t or self.now())

    def review_issue(self, e, t=None):
        # The nightly conversation review found a problem in a real conversation (Oct 7). One finding per problem (the
        # reviewer's own words, so the same problem in two conversations is usually two findings; the fixer's 3-a-night cap holds).
        if e.get('qa') or e.get('severity') not in ('high', 'medium'): return
        sess = e.get('session', '')
        ev = '%s | %s | Rachel said: %s | customer said: %s | should have: %s | fix area: %s' % (
            e.get('category', '?'), e.get('what_happened', ''), str(e.get('rachel_said', ''))[:400], str(e.get('customer_said', ''))[:300],
            str(e.get('should_have', ''))[:300], e.get('fix_area', '?'))
        sev = e['severity'] if e['severity'] == 'high' else self.d.get('conversation_review', {}).get('severity', 'medium')
        self.store.record('conversation_review', sev, '%s: %s (%s)' % (e.get('category', 'other'), str(e.get('what_happened', ''))[:120], sess), [ev], [sess], t or self.now())

    def side_test(self, e, t=None):
        # A nightly side test (connector test, monitor self-test) failed: qa/nightly.sh -> logs/side-tests.jsonl (Oct 4).
        if e.get('ok'): return
        self.store.record('side_test', self.d.get('side_test', {}).get('severity', 'high'), 'nightly %s failed' % e.get('test', '?'),
                          ['%s: %s' % (e.get('test', '?'), x) for x in (e.get('detail') or ['(no detail)'])], [], t or self.now())

    def qa_summary(self, path, t=None):
        try: s = json.load(open(path))
        except Exception: return
        if s.get('failed'):
            self.store.record('qa_fail', self.d['qa_fail']['severity'], 'QA run %s: %d failed (%s)' % (s.get('stamp', '?'), len(s['failed']), ', '.join(s['failed'][:6])),
                              ['%s: %s' % (os.path.basename(os.path.dirname(path)), x) for x in s['failed']], [], t or self.now())

    def services(self, t=None):
        t = t or self.now(); deploying = recent_deploy(self.cfg.get('deploy_grace_minutes', 15))
        for svc in self.cfg['services']:
            out = subprocess.run(['systemctl', 'show', svc, '-p', 'ActiveState', '-p', 'ActiveEnterTimestamp', '--value'], capture_output=True, text=True).stdout.split('\n')
            state, since = (out + ['', ''])[0].strip(), (out + ['', ''])[1].strip()
            prev = self.svc_seen.get(svc); self.svc_seen[svc] = (state, since)
            if state not in ('active', 'activating', 'reloading'):
                self.store.record('crash', self.d['crash']['severity'], 'service %s is %s' % (svc, state or 'unknown'), ['systemctl: %s %s' % (svc, state)], [], t)
            elif prev and prev[1] and since != prev[1] and not deploying:
                self.store.record('crash', self.d['crash']['severity'], 'service %s restarted outside a deploy' % svc, ['systemctl: %s restarted at %s (was %s)' % (svc, since, prev[1])], [], t)

def recent_deploy(minutes):
    cutoff = time.time() - minutes * 60
    return any(os.path.getmtime(p) > cutoff for p in glob.glob(LOGS + '/deploy-*.log'))

# ── tailing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def load_state():
    try: return json.load(open(STATE))
    except Exception: return {}
def save_state(st):
    tmp = STATE + '.tmp'; json.dump(st, open(tmp, 'w')); os.replace(tmp, STATE)

def new_lines(path, st, key):
    """Lines appended since the last pass. First sight of a file = start at its end (history is for --replay).
    A file that did not exist yet starts at 0: everything written to it is new (Oct 7: review-issues.jsonl was created
    after the monitor started, so its first 3 issues were skipped as history and never reached the fixer)."""
    try: size = os.path.getsize(path)
    except OSError:
        st.setdefault(key, 0); return []
    off = st.get(key)
    if off is None or off > size: st[key] = size if off is None else 0   # first sight: skip history; truncated: start over
    if off is None: return []
    with open(path, 'rb') as fh:
        fh.seek(st[key]); data = fh.read(); st[key] = fh.tell()
    return data.decode('utf-8', 'replace').splitlines()

def one_pass(mon, st):
    for src, path in TEXT_LOGS.items():
        for line in new_lines(path, st, 'off:' + path): mon.text_line(src, line)
    for line in new_lines(EVENTS, st, 'off:' + EVENTS):
        try: mon.event(json.loads(line))
        except Exception: pass
    for line in new_lines(FEEDBACK, st, 'off:' + FEEDBACK):
        try: mon.feedback(json.loads(line))
        except Exception: pass
    for line in new_lines(REVIEW_ISSUES, st, 'off:' + REVIEW_ISSUES):
        try: mon.review_issue(json.loads(line))
        except Exception: pass
    for line in new_lines(SIDE_TESTS, st, 'off:' + SIDE_TESTS):
        try: mon.side_test(json.loads(line))
        except Exception: pass
    seen = set(st.get('qa_seen', []))
    for p in sorted(glob.glob(QA_RUNS + '/*/summary.json'))[-20:]:
        if p not in seen:
            if st.get('qa_init'): mon.qa_summary(p)
            seen.add(p)
    st['qa_seen'] = sorted(seen)[-200:]; st['qa_init'] = True
    mon.services()
    mon.store.expire()

# ── Slack (critical only, once OPS_SLACK_CHANNEL exists) ────────────────────────────────────────────────────────────
def env_file(path='/etc/rachel.env'):
    out = {}
    try:
        for l in open(path):
            if '=' in l and not l.lstrip().startswith('#'): k, v = l.split('=', 1); out[k.strip()] = v.strip().strip('"\'')
    except OSError: pass
    return out

PLAIN = {   # detector -> (what it means for customers, what a person could do). Slack text for DC (not an engineer); the fixer uses it too
    'crash':              ('Part of Rachel hit an error and stopped mid-task, so a customer may have got no reply or a broken one.',
                           'Look at the technical details below, or let the fixer try again tomorrow night.'),
    'upstream_error':     ("Bevvi's store system (product search / ordering) sent back errors several times in a few minutes, so Rachel couldn't look up products or place orders properly.",
                           "Usually a short outage on Bevvi's side. If it keeps happening, check with the Bevvi API team."),
    'llm_error':          ("Rachel's AI provider (Anthropic) failed to answer several times in a few minutes, so some customers may have waited or got no reply.",
                           'Usually a short outage that fixes itself. If it keeps happening, check status.anthropic.com and our Anthropic billing.'),
    'stuck_turn':         ('Rachel started answering a customer and never finished (2+ minutes with no reply).', 'Check whether that customer needs a follow-up.'),
    'slow_turn':          ('A customer waited more than a minute for one reply from Rachel.', "Often the AI provider or Bevvi's product search being slow. Worth a look if it keeps happening."),
    'unmatched_spike':    ("Customers kept asking for the same product and Rachel kept telling them it isn't available.",
                           'Check whether the store really carries it under another name.'),
    'resolver_miss':      ("Customers picked an option from a numbered list Rachel showed them, and Rachel didn't understand which one they meant.", ''),
    'stuck_session':      ('A conversation went in circles: Rachel kept asking the same thing, or the customer kept repeating themselves.',
                           'Read that conversation and check whether the customer needs help.'),
    'latency':            ('Rachel has been slow overall for the past hour (a typical reply took more than 20 seconds).',
                           "Often the AI provider or Bevvi's product search being slow. If it lasts, it's worth a look."),
    'side_test':          ("One of the nightly extra checks failed (for example the Claude connector test: signing in, the age question, a practice order). No real customer was involved.",
                           'An engineer should look at the failing step listed below.'),
    'qa_fail':            ("One of Rachel's automatic practice conversations went wrong. No real customer was involved, but a real customer would probably hit the same thing.", ''),
    'escalation_request': ('A customer asked to talk to a person.', 'Someone should reach out to that customer.'),
    'feedback':           ('Someone told Rachel she got something wrong — a correction in their message ("I already told you…"), a "Rachel feedback:" note, or a 👎 on her reply in Slack.',
                           'Read what they said and what Rachel had said just before; the fixer turns it into a test and a fix.'),
    'conversation_review': ("The nightly read-through of yesterday's real conversations found a place where Rachel let a customer down (wrong item, ignored what they said, a dead end, a lost customer).",
                           'Read what happened below. The fixer tries a code fix; a change to how Rachel talks comes to you as a decision.'),
    'watchdog_alert':     ('The nightly health check found something wrong.', 'See the technical details below.'),
}

def alert(f):
    e = env_file(); tok, ch = e.get('SLACK_BOT_TOKEN'), e.get('OPS_SLACK_CHANNEL')
    meaning = PLAIN.get(f['detector'], (f['summary'], ''))[0]
    text = (':rotating_light: *Urgent — %s*: %s\nSeen %s so far. The fixer will look at it tonight; if it is not something it is allowed '
            'to fix, you will get a "Needs a decision" message.\n_For engineers: %s, %s · %s_' % (f['id'], meaning, 'once' if f['count'] == 1 else '%d times' % f['count'],
                                                                                             f['detector'], f['severity'], f['summary'][:160]))
    if not (tok and ch):
        log('ALERT (not posted — OPS_SLACK_CHANNEL not set): ' + text); return
    try:
        req = urllib.request.Request('https://slack.com/api/chat.postMessage', data=json.dumps({'channel': ch, 'text': text}).encode(),
                                     headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10).read(); log('alert posted: ' + f['id'])
    except Exception as ex: log('alert FAILED (' + str(ex)[:80] + '): ' + text)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--once', action='store_true'); ap.add_argument('--status', action='store_true'); ap.add_argument('--replay')
    a = ap.parse_args()
    cfg = yaml.safe_load(open(CFG_FILE))
    if a.status:
        items = Store().items; op = [f for f in items if f['status'] in ('open', 'fixing', 'review')]
        print('%d open finding(s) of %d' % (len(op), len(items)))
        for f in sorted(op, key=lambda f: ['critical', 'high', 'medium', 'low', 'info'].index(f['severity'])):
            print('  %s  %-8s %-18s ×%-4d last %s  %s' % (f['id'], f['severity'], f['detector'], f['count'], f['last_seen'], f['summary'][:110]))
        return
    if a.replay:
        store = Store(path='/dev/null', dry=True); store.items = []
        mon = Monitor(cfg, store); src = next((s for s, p in TEXT_LOGS.items() if os.path.basename(p) == os.path.basename(a.replay)), 'rachel')
        t0 = time.time() - 86400; n = 0
        for i, line in enumerate(open(a.replay, errors='replace')):
            n += 1
            if a.replay.endswith('.jsonl'):
                try:
                    e = json.loads(line); ts = time.mktime(time.strptime(e['ts'][:19], '%Y-%m-%dT%H:%M:%S')); mon.event(e, ts)
                except Exception: pass
            else: mon.text_line(src, line, t0 + i * 0.05)   # untimestamped lines: ~20/s, in order
        by = collections.Counter(f['detector'] for f in store.items)
        print('replay %s: %d lines -> %d finding(s) %s' % (a.replay, n, len(store.items), dict(by)))
        for f in store.items[:40]: print('  %-8s %-18s ×%-4d %s' % (f['severity'], f['detector'], f['count'], f['summary'][:120]))
        return
    store = Store(dedupe_days=cfg.get('dedupe_days', 7), evidence_cap=cfg.get('evidence_lines', 40))
    mon = Monitor(cfg, store); st = load_state()
    log('started — findings in %s, %d already recorded' % (FINDINGS, len(store.items)))
    while True:
        store.new = []
        if os.path.exists(HOME + '/ops/PAUSE'): pass   # the kill switch stops the fixer; the monitor keeps recording
        one_pass(mon, st); save_state(st)
        for f in store.new:
            log('NEW %s %s %s: %s' % (f['id'], f['severity'], f['detector'], f['summary'][:150]))
            if f['severity'] == 'critical' and cfg.get('critical_immediate', True): alert(f)
        if a.once: return
        time.sleep(cfg.get('poll_seconds', 30))

if __name__ == '__main__': main()
