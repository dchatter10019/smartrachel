#!/usr/bin/env python3
"""Monitor detectors on canned lines (Debug-and-Fix Loop spec, "Testing the loop"): every detector produces its finding,
repeats dedupe, QA traffic never trips a customer-facing detector, evidence is redacted. Writes nothing outside /tmp."""
import json, os, sys, tempfile, yaml
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import monitor as M

cfg = yaml.safe_load(open(os.path.join(os.path.dirname(__file__), '..', 'monitor.yaml')))
tmp = tempfile.mktemp(suffix='.jsonl')
store = M.Store(path=tmp)
mon = M.Monitor(cfg, store)
fails = 0
def check(label, cond):
    global fails
    print(('  ✓ ' if cond else '  ✗ ') + label); fails += 0 if cond else 1
def found(det): return [f for f in store.items if f['detector'] == det]
T = 1_800_000_000

# crash: one finding for the same error in two sessions; count 2
mon.text_line('rachel', "[rachel] error: TypeError: Cannot read properties of undefined (reading 'qty') «qa-a-1»", T)
mon.text_line('rachel', "[rachel] error: TypeError: Cannot read properties of undefined (reading 'qty')", T + 5)
check('crash: a stack/TypeError line is a critical finding', len(found('crash')) == 1 and found('crash')[0]['severity'] == 'critical')
check('crash: the same error again dedupes (count 2, one finding)', found('crash')[0]['count'] == 2)
# upstream: 3 Bevvi 503s in 10 min
for i in range(3): mon.text_line('shopping-agent', '[searchProducts] HTTP 503 — retry 1/2', T + i * 60)
check('upstream_error: 3 Bevvi 503s in 10 min', len(found('upstream_error')) == 1)
# 2 503s spread over an hour: nothing new
for i in range(2): mon.text_line('shopping-agent', '[searchProducts] HTTP 503 — retry 1/2', T + 4000 + i * 1800)
check('upstream_error: 2 in an hour do not trip it', found('upstream_error')[0]['count'] == 1)
# llm
for i in range(3): mon.text_line('rachel', '[classify] other (0.7) [llm(sonnet:fetch failed(retried))] | "hi"', T + i)
check('llm_error: 3 API errors in 10 min', len(found('llm_error')) == 1)
# slow turn + latency, customers only
mon.event({'session': 'slack-x', 'channel': 'slack', 'qa': False, 'latency_ms': 75000, 'state_out': 'ready'}, T)
mon.event({'session': 'qa-y', 'channel': 'slack', 'qa': True, 'latency_ms': 300000, 'state_out': 'ready'}, T)
check('slow_turn: a customer turn over 60 s; a QA turn never', len(found('slow_turn')) == 1 and 'qa-y' not in found('slow_turn')[0]['sessions'])
for i in range(5): mon.event({'session': 'email-z', 'channel': 'email', 'qa': False, 'latency_ms': 25000, 'state_out': 'ready'}, T + i * 60)
check('latency: email median over 20 s for 5+ turns', len(found('latency')) == 1)
# unmatched: same product 5x for customers, QA ignored
for i in range(5): mon.event({'session': 's%d' % i, 'channel': 'email', 'qa': False, 'unmatched': ['Casamigos Blanco'], 'state_out': 'ready'}, T + i)
for i in range(9): mon.event({'session': 'q%d' % i, 'channel': 'email', 'qa': True, 'unmatched': ['Paul Hobbs'], 'state_out': 'ready'}, T + i)
check('unmatched_spike: a product unavailable 5x for customers', len(found('unmatched_spike')) == 1 and 'casamigos blanco' in found('unmatched_spike')[0]['summary'])
check('unmatched_spike: QA unavailable products never count', not any('paul hobbs' in f['summary'] for f in found('unmatched_spike')))
# stuck session: same non-ready state 4 turns; a repeated message
for i in range(4): mon.event({'session': 'wa-1', 'channel': 'whatsapp', 'qa': False, 'state_out': 'age_gate', 'latency_ms': 1000}, T + i)
mon.text_line('rachel', '[rachel] chat — session: email-abc-sean messages: 4 — "can you send the link"', T)
mon.text_line('rachel', '[rachel] chat — session: email-abc-sean messages: 6 — "can you send the link"', T + 30)
check('stuck_session: 4 turns in age_gate, and a repeated message', len(found('stuck_session')) == 2)
mon.text_line('rachel', '[rachel] chat — session: qa-loop-1 messages: 4 — "same"', T); mon.text_line('rachel', '[rachel] chat — session: qa-loop-1 messages: 6 — "same"', T)
check('stuck_session: a QA session repeating never counts', len(found('stuck_session')) == 2)
# escalation, watchdog, qa summary
mon.text_line('rachel', '[rachel] chat — session: whatsapp-+15550001234 messages: 2 — "can I talk to a human please"', T)
check('escalation_request: "talk to a human" (info)', len(found('escalation_request')) == 1 and found('escalation_request')[0]['severity'] == 'info')
check('evidence: phone numbers redacted', '0001234' not in json.dumps(found('escalation_request')[0]['evidence']) and '1234' in json.dumps(found('escalation_request')[0]['evidence']))
mon.text_line('watchdog', '[2026-10-03T03:15:01Z] ISSUES FOUND: GBrain unreachable', T)
check('watchdog_alert: the nightly watchdog reported an issue', len(found('watchdog_alert')) == 1)
d = tempfile.mkdtemp(); p = os.path.join(d, 'summary.json'); json.dump({'stamp': 'x', 'passed': 60, 'failed': ['order-flow']}, open(p, 'w'))
mon.qa_summary(p, T)
check('qa_fail: a QA run with failures', len(found('qa_fail')) == 1 and 'order-flow' in found('qa_fail')[0]['summary'])
check('redact: tokens and webhook URLs', M.redact('x xoxb-123-abc https://hooks.slack.com/services/T/B/C') == 'x <redacted-token> https://hooks.slack.com/<redacted>')
# feedback (Oct 3): a correction / 👎 from a customer is a finding with what Rachel had said; QA feedback never is
mon.feedback({'kind': 'correction', 'session': 'email-abc-sean', 'who': 'dc@x.com', 'text': 'Mara is not the customer', 'rachel_said': "I need Mara's last name", 'qa': False}, T)
mon.feedback({'kind': 'correction', 'session': 'email-abc-sean', 'who': 'dc@x.com', 'text': 'I already told you', 'rachel_said': "I need Mara's last name", 'qa': False}, T + 60)
mon.feedback({'kind': 'thumbs_down', 'session': 'qa-fb-1', 'who': 'qa-fb@getbevvi.com', 'text': '👎', 'rachel_said': 'x', 'qa': True}, T)
fb = found('feedback')
check('feedback: one finding per conversation (count 2), evidence has what Rachel said, QA ignored', len(fb) == 1 and fb[0]['count'] == 2 and any("Mara's last name" in e for e in fb[0]['evidence']))
# side tests (Oct 4): a failed nightly connector test is a finding with the failing step; a pass is not
mon.side_test({'test': 'mcp_connector_test', 'ok': False, 'detail': ['  ✗ connector api key + two-step order: chat after age -> ASKED AGAIN']}, T)
mon.side_test({'test': 'monitor_test', 'ok': True, 'detail': []}, T)
st_ = found('side_test')
check('side test: a failure is one finding with the failing step, a pass is none', len(st_) == 1 and 'ASKED AGAIN' in st_[0]['evidence'][0])
# conversation review (Oct 7): a high / medium issue from the nightly review is a finding with what Rachel said; low and QA are not
mon.review_issue({'severity': 'high', 'category': 'dead_end', 'what_happened': 'Asked for an address and never showed the reds', 'rachel_said': 'What is your delivery address?', 'session': 'mcp-x@y.com', 'qa': False}, T)
mon.review_issue({'severity': 'low', 'category': 'tone', 'what_happened': 'A bit long', 'session': 'slack-x', 'qa': False}, T)
mon.review_issue({'severity': 'high', 'category': 'dead_end', 'what_happened': 'QA one', 'session': 'qa-1', 'qa': True}, T)
cr = found('conversation_review')
check('conversation review: a high issue is one high finding with what Rachel said; low and QA ignored', len(cr) == 1 and cr[0]['severity'] == 'high' and 'delivery address' in cr[0]['evidence'][0])
check('findings file written', sum(1 for _ in open(tmp)) == len(store.items))
# two writers (Oct 3): a status set by another process (fixer / deploy-fix / Slack ❌ / by hand) survives the long-running
# monitor's next save, and the monitor's own update to a finding still lands
other = M.Store(path=tmp)
fid = found('qa_fail')[0]['id']
[f.update(status='resolved') for f in other.items if f['id'] == fid]; other._save()
mon.text_line('rachel', "[rachel] error: TypeError: Cannot read properties of undefined (reading 'qty') «qa-a-9»", T + 5)
on_disk = {f['id']: f for f in M.Store(path=tmp).items}
check('store: another writer\'s status survives the monitor\'s save', on_disk[fid]['status'] == 'resolved')
check('store: the monitor sees it too (no stale copy)', [f for f in store.items if f['id'] == fid][0]['status'] == 'resolved')
crash = [f for f in on_disk.values() if f['detector'] == 'crash'][0]
check('store: the monitor\'s own update still lands', crash['count'] >= 3)
os.remove(tmp)
print('monitor test: ' + ('all passed' if not fails else '%d FAILED' % fails))
sys.exit(1 if fails else 0)
