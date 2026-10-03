#!/usr/bin/env python3
"""AI spend report (DC, Oct 3). Reads logs/ai-spend.jsonl (every Anthropic call Rachel's code makes, rachel/ai-spend.js)
and logs/fixer/spend.jsonl (the nightly fixer). Customers vs tests (QA sessions, staging, the QA judge) vs the fixer.

  ops/ai-spend.py                  yesterday (UTC) + month to date, one Slack line (the nightly QA summary appends it)
  ops/ai-spend.py --day 2026-10-03 that day instead of yesterday
  ops/ai-spend.py --detail         per-kind breakdown too (rachel / classifier / reviewer / web-price / image / qa-judge)
Not covered: gbrain's own model calls (separate service)."""
import argparse, collections, datetime, json

LEDGER = '/home/ubuntu/logs/ai-spend.jsonl'
FIXER = '/home/ubuntu/logs/fixer/spend.jsonl'
KIND = {'rachel': "Rachel's replies", 'classifier': 'message sorting', 'reviewer': 'package checks', 'web-price': 'web price lookups',
        'image': 'reading photos', 'qa-judge': 'test grading', 'fixer': 'auto-fixer'}

def rows():
    for path, fixer in ((LEDGER, False), (FIXER, True)):
        try:
            for l in open(path):
                try: r = json.loads(l)
                except Exception: continue
                if fixer: r = {'ts': r.get('at', ''), 'kind': 'fixer', 'test': False, 'usd': r.get('cost_usd') or 0, 'fixer': True}
                yield r
        except OSError: pass

def bucket(r):
    return 'fixer' if r.get('fixer') else ('tests' if r.get('test') else 'customers')

def totals(pred):
    t = collections.Counter(); k = collections.Counter(); unpriced = 0
    for r in rows():
        if not pred(r.get('ts', '')): continue
        if r.get('usd') is None: unpriced += 1; continue
        t[bucket(r)] += r['usd']; k[r.get('kind', '?')] += r['usd']
    return t, k, unpriced

def money(x): return '$%.2f' % x

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--day'); ap.add_argument('--detail', action='store_true'); a = ap.parse_args()
    now = datetime.datetime.now(datetime.timezone.utc)
    day = a.day or (now - datetime.timedelta(days=1)).strftime('%Y-%m-%d')
    month = day[:7]
    d, dk, du = totals(lambda ts: ts[:10] == day)
    m, mk, mu = totals(lambda ts: ts[:7] == month)
    label = datetime.datetime.strptime(day, '%Y-%m-%d'); dname = label.strftime('%b ') + str(label.day); mname = label.strftime('%B')
    line = ('💸 *AI spend* — %s: *%s* (customers %s · tests %s · auto-fixer %s) · %s so far: *%s* (customers %s · tests %s · auto-fixer %s)'
            % (dname, money(sum(d.values())), money(d['customers']), money(d['tests']), money(d['fixer']),
               mname, money(sum(m.values())), money(m['customers']), money(m['tests']), money(m['fixer'])))
    top = [KIND.get(k, k) + ' ' + money(v) for k, v in dk.most_common(3) if v >= 0.005]
    if top: line += '\nBiggest on %s: %s' % (dname, ', '.join(top))
    if du or mu: line += '\n_%d call(s) this month had no known price and are not counted_' % mu
    print(line)
    if a.detail:
        for k, v in mk.most_common(): print('  %-12s %s  (%s)' % (k, money(v), mname))

if __name__ == '__main__': main()
