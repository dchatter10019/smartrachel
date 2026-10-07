#!/usr/bin/env python3
"""Nightly conversation review (DC, Oct 7: "log every conversation and analyze end of the night and make adjustments").

Reads the day's customer conversations from logs/transcripts.jsonl (every channel, every outcome — rachel/transcripts.js),
has Claude read each one as a reviewer and say where Rachel let the customer down, and:
  - writes the whole review to logs/conversation-reviews/<UTC date>.json
  - appends each high / medium problem to logs/review-issues.jsonl -> monitor detector `conversation_review` -> a finding
    -> the nightly fixer (ops/scope.yaml): a code fix comes back as "Fix ready" for DC's ✅; a prompt.md change (protected)
    comes back as "Needs a decision". Nothing changes Rachel without that approval.
  - prints a plain-language summary for DC (qa/nightly.sh posts it to Slack)

  ops/conversation-review.py              conversations since the last review (first run: the last 24h)
  ops/conversation-review.py --hours 48   a fixed window instead (does not move the bookmark)
  ops/conversation-review.py --dry        list what would be reviewed; no model calls, nothing written

QA identities are never reviewed (they test edge cases on purpose). Spend: ops/monitor.yaml conversation_review: (model,
max_usd per night, max_conversations); each call goes to logs/ai-spend.jsonl as kind conversation-review.
"""
import argparse, collections, datetime, json, os, re, sys, time, urllib.request
import yaml

LOGS = '/home/ubuntu/logs'
TRANSCRIPTS = os.environ.get('RACHEL_TRANSCRIPTS_FILE', LOGS + '/transcripts.jsonl')
OUT = os.environ.get('REVIEW_OUT', LOGS)   # outputs elsewhere for a test run (nothing reaches the monitor)
OUT_DIR = OUT + '/conversation-reviews'
ISSUES = OUT + '/review-issues.jsonl'
STATE = OUT + '/conversation-review-state.json'
SPEND = os.environ.get('AI_SPEND_FILE', LOGS + '/ai-spend.jsonl')
CFG = '/home/ubuntu/ops/monitor.yaml'
PRICES = {'claude-sonnet-4-6': (3, 15), 'claude-sonnet-5-5': (2, 10), 'claude-haiku-4-5': (1, 5), 'claude-opus-5-5': (4, 20)}   # $/M in, out (rachel/ai-spend.js)

def log(m): print('[review] ' + m, file=sys.stderr, flush=True)

def env(path='/etc/rachel.env'):
    out = {}
    try:
        for l in open(path):
            if '=' in l and not l.lstrip().startswith('#'): k, v = l.split('=', 1); out[k.strip()] = v.strip().strip('"\'')
    except OSError: pass
    return out

def parse_ts(s):
    try: return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception: return 0

def load(since, context_days=3):
    """Customer turns since `since`, plus up to `context_days` of earlier turns of the same sessions (marked earlier)."""
    rows = []
    try:
        for l in open(TRANSCRIPTS):
            try: r = json.loads(l)
            except Exception: continue
            if r.get('qa'): continue
            t = parse_ts(r.get('ts', ''))
            if t >= since - context_days * 86400: r['_t'] = t; rows.append(r)
    except OSError: pass
    sess = collections.OrderedDict()
    for r in rows: sess.setdefault(r.get('session') or '?', []).append(r)
    convs = []
    for sid, turns in sess.items():
        new = [r for r in turns if r['_t'] >= since]
        if not new: continue
        convs.append({'session': sid, 'channel': new[-1].get('channel', '?'), 'customer': new[-1].get('customer', ''),
                      'turns': turns, 'new_from': turns.index(new[0]), 'actions': [r.get('action') for r in new]})
    return convs

def render(c):
    out = []
    for i, r in enumerate(c['turns']):
        if i == c['new_from'] and i: out.append('──── (above: earlier in this conversation, already reviewed) ────')
        ts = r.get('ts', '')[:16].replace('T', ' ')
        if r.get('tool'):
            out.append('[%s] CONNECTOR TOOL %s %s' % (ts, r['tool'], r.get('message', '')[:600]))
            if r.get('result'): out.append('  → shown to the client: ' + r['result'][:1500])
            continue
        out.append('[%s] CUSTOMER: %s' % (ts, r.get('message', '')))
        meta = ', '.join('%s=%s' % (k, r[k]) for k in ('action', 'state_out', 'basket_items', 'basket_total') if r.get(k) not in (None, ''))
        out.append('[%s] RACHEL (%s): %s' % (ts, meta, r.get('reply', '')))
    return '\n'.join(out)

def priority(c):
    # Conversations that didn't reach an order / proposal, or where the customer pushed back, are read first.
    a = set(c['actions']); words = ' '.join(r.get('message', '') for r in c['turns'][c['new_from']:]).lower()
    done = bool(a & {'placed_order', 'generated_proposal'})
    pushback = bool(re.search(r"already told|that'?s wrong|not what i|still|again|no,|wrong|doesn'?t|didn'?t|isn'?t right|confus", words))
    return (0 if pushback else 1, 1 if done else 0, -len(c['turns']))

PROMPT = """You review conversations of Rachel, Bevvi's AI beverage ordering assistant (wine, beer, spirits delivered by local
stores; customers reach her on Slack, email, WhatsApp, or through Claude via a connector whose tool calls are shown).
Rachel's job: understand what the customer wants, find it in the store's catalog, build a priced basket, and place the
order or send a PDF proposal. Her standing rules include: age is confirmed every conversation; a stated quantity is an
order, not an event question; she spends the stated budget (no downselling); she never comments on prices being high/low;
stock the customer already has is never ordered; a customer-named product is never silently swapped for another type.

Read the conversation below (it may have only one turn) and judge ONLY the part after the "earlier" marker, if any.
Find real problems — places where Rachel was wrong, ignored what the customer said, asked for something she already
had, offered the wrong product/size/quantity/price, said something isn't available when the shown results suggest it is,
left the customer with no clear next step, looped, or lost the customer. Do not invent problems: a short conversation
that simply ended (e.g. the customer didn't reply to a reasonable question) is "abandoned" with no issue unless Rachel's
question was the reason. Asking for the delivery address before showing products is current intended behavior, but say
so as a low issue if it clearly cost the conversation.

Reply with JSON only:
{"customer_goal": "<one line>",
 "outcome": "ordered|proposal|quote_sent|answered|abandoned|ongoing",
 "customer_satisfied": true|false|null,
 "issues": [{"severity": "high|medium|low",
             "category": "wrong_product|wrong_quantity|wrong_price|ignored_instruction|repeated_question|false_unavailable|dead_end|loop|tone|rule_broken|other",
             "what_happened": "<plain English, one or two sentences, for a non-engineer>",
             "rachel_said": "<short exact quote from Rachel>",
             "customer_said": "<short exact quote from the customer, if relevant>",
             "should_have": "<what Rachel should have done>",
             "fix_area": "code|prompt|catalog|none"}]}
high = customer got something wrong or was lost; medium = friction a customer noticed; low = could be better."""

def call(model, text, key):
    body = json.dumps({'model': model, 'max_tokens': 1500, 'temperature': 0,
                       'system': PROMPT, 'messages': [{'role': 'user', 'content': 'CONVERSATION:\n' + text}]}).encode()
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=body, headers={
        'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    r = json.loads(urllib.request.urlopen(req, timeout=120).read())
    u = r.get('usage', {}); p = PRICES.get(model)
    usd = (u.get('input_tokens', 0) * p[0] + u.get('output_tokens', 0) * p[1]) / 1e6 if p else None
    try:
        with open(SPEND, 'a') as fh:
            fh.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'kind': 'conversation-review', 'model': model, 'test': False,
                                 'env': 'review', 'in': u.get('input_tokens', 0), 'cw': 0, 'cr': 0, 'out': u.get('output_tokens', 0), 'ws': 0,
                                 'usd': round(usd, 6) if usd is not None else None}) + '\n')
    except Exception as e: log('ai-spend write failed: %s' % e)
    txt = ''.join(b.get('text', '') for b in r.get('content', []) if b.get('type') == 'text')
    m = re.search(r'\{[\s\S]*\}', txt)
    return json.loads(m.group(0)) if m else None, usd or 0

CH = {'slack': 'Slack', 'email': 'email', 'whatsapp': 'WhatsApp', 'mcp': 'Claude connector', 'web': 'web'}

def summary(day, reviewed, skipped, spent, convs):
    by_ch = collections.Counter(CH.get(c['channel'], c['channel']) for c in convs)
    outs = collections.Counter((r.get('review') or {}).get('outcome', 'not reviewed') for r in reviewed)
    issues = [(r, i) for r in reviewed for i in (r.get('review') or {}).get('issues', [])]
    hi = [x for x in issues if x[1].get('severity') == 'high']; med = [x for x in issues if x[1].get('severity') == 'medium']
    lines = ['🗣️ *Rachel conversation review — %s*' % day,
             '%d customer conversation(s): %s' % (len(convs), ', '.join('%d %s' % (n, k) for k, n in by_ch.most_common()) or 'none')]
    if reviewed:
        lines.append('How they ended: ' + ', '.join('%d %s' % (n, k.replace('_', ' ')) for k, n in outs.most_common()))
        lines.append('Problems found: %d serious, %d noticeable, %d minor' % (len(hi), len(med), len(issues) - len(hi) - len(med)))
        for r, i in (hi + med)[:6]:
            lines.append('• %s (%s, %s): %s' % ('🔴' if i.get('severity') == 'high' else '🟠', r['customer'] or r['session'], CH.get(r['channel'], r['channel']), i.get('what_happened', '')))
        if hi or med: lines.append('Serious and noticeable problems go to the fixer tonight; anything that changes how Rachel talks comes to you as "Needs a decision".')
    if skipped: lines.append('_%d conversation(s) not reviewed (nightly limit)_' % skipped)
    lines.append('_Review cost: $%.2f_' % spent)
    return '\n'.join(lines)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--hours', type=float); ap.add_argument('--dry', action='store_true'); a = ap.parse_args()
    cfg = (yaml.safe_load(open(CFG)) or {}).get('conversation_review', {})
    model, max_usd, max_n = cfg.get('model', 'claude-sonnet-4-6'), float(cfg.get('max_usd', 3)), int(cfg.get('max_conversations', 40))
    try: st = json.load(open(STATE))
    except Exception: st = {}
    now = time.time()
    since = now - a.hours * 3600 if a.hours else st.get('last_ts', now - 86400)
    convs = load(since)
    convs.sort(key=priority)
    day = time.strftime('%Y-%m-%d', time.gmtime(now))
    log('%d customer conversation(s) since %s' % (len(convs), time.strftime('%Y-%m-%d %H:%M', time.gmtime(since))))
    if a.dry:
        for c in convs: print('%-45s %-8s %3d turn(s) %s' % (c['session'][:45], c['channel'], len(c['turns']) - c['new_from'], ','.join(x or '?' for x in c['actions'])[:60]))
        return
    key = os.environ.get('ANTHROPIC_API_KEY') or env().get('ANTHROPIC_API_KEY')
    if not key: log('no ANTHROPIC_API_KEY — nothing reviewed'); sys.exit(1)
    reviewed, spent, skipped = [], 0.0, 0
    for c in convs:
        if len(reviewed) >= max_n or spent >= max_usd:
            skipped += 1; log('NOT reviewed (nightly limit: %d conversations / $%.2f): %s' % (max_n, max_usd, c['session'])); continue
        text = render(c)[-60000:]
        try: rv, usd = call(model, text, key)
        except Exception as e: rv, usd = None, 0; log('review FAILED for %s: %s' % (c['session'], e))
        spent += usd
        if rv is None: log('no usable review for %s' % c['session'])
        reviewed.append({'session': c['session'], 'channel': c['channel'], 'customer': c['customer'], 'turns': len(c['turns']) - c['new_from'], 'review': rv})
    os.makedirs(OUT_DIR, exist_ok=True)
    with open('%s/%s.json' % (OUT_DIR, day), 'w') as fh:
        json.dump({'day': day, 'since': since, 'model': model, 'usd': round(spent, 4), 'skipped': skipped, 'conversations': reviewed}, fh, indent=1)
    n_iss = 0
    with open(ISSUES, 'a') as fh:
        for r in reviewed:
            for i in (r.get('review') or {}).get('issues', []):
                if i.get('severity') not in ('high', 'medium'): continue
                n_iss += 1
                fh.write(json.dumps(dict(i, ts=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), session=r['session'], channel=r['channel'],
                                         customer=r['customer'], qa=False, day=day)) + '\n')
    if not a.hours:
        st['last_ts'] = now; json.dump(st, open(STATE, 'w'))
    log('reviewed %d, skipped %d, %d issue(s) for the monitor, $%.3f' % (len(reviewed), skipped, n_iss, spent))
    print(summary(day, reviewed, skipped, spent, convs))

if __name__ == '__main__': main()
