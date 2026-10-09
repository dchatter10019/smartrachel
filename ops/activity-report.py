#!/usr/bin/env python3
"""Daily activity report (DC, Oct 9: "add that" — who used Rachel, on which channel, what they asked, how it ended).
Reads RACHEL_DATA_DIR/transcripts.jsonl (every /chat turn + every connector tool call, rachel/transcripts.js; starts Oct 7).
QA identities and «qa-» sessions are left out. No model calls — costs nothing.

  ops/activity-report.py                  yesterday (UTC), Slack text (the nightly QA summary appends it)
  ops/activity-report.py --day 2026-10-08 that day instead"""
import argparse, collections, datetime, json, os

TRANSCRIPTS = os.environ.get('RACHEL_TRANSCRIPTS_FILE') or os.path.join(os.environ.get('RACHEL_DATA_DIR', '/home/ubuntu/logs'), 'transcripts.jsonl')
CH = {'slack': 'Slack', 'email': 'Email', 'whatsapp': 'WhatsApp', 'mcp': 'Claude connector', 'web': 'Web'}
TOOL = {'rachel_search': 'search', 'rachel_recommend': 'recommend', 'rachel_build_package': 'event package', 'rachel_chat': 'chat',
        'rachel_place_order': 'order prepared', 'rachel_confirm_order': 'order confirmed', 'rachel_generate_proposal': 'proposal',
        'rachel_get_session': 'basket check', 'rachel_verify_age': 'age check', 'rachel_feedback': 'feedback'}

def is_qa(r):
    return r.get('qa') or str(r.get('session', '')).startswith('qa-') or str(r.get('customer', '')).lower().startswith(('qa-', 'rachel_qa'))

def ask_of(r):
    """What the customer asked, in a few words: their message, or the connector tool's main argument."""
    if not r.get('tool'): return r.get('message', '')
    try: a = json.loads(r.get('message') or '{}')
    except Exception: return ''
    t = r['tool']
    if t == 'rachel_search': return ', '.join(a.get('products') or [])
    if t == 'rachel_recommend': return ' '.join(str(a.get(k)) for k in ('category', 'occasion') if a.get(k))
    if t == 'rachel_build_package':
        return 'event: ' + ', '.join('%s %s' % (k, a[k]) for k in ('guests', 'hours', 'budget') if a.get(k)) + \
               ((' — ' + str(a.get('request'))) if a.get('request') else '')
    if t == 'rachel_chat': return a.get('message', '')
    return ''

def clip(s, n=90):
    s = ' '.join(str(s or '').split())
    return s if len(s) <= n else s[:n - 1] + '…'

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--day'); a = ap.parse_args()
    day = a.day or (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).strftime('%Y-%m-%d')
    sess = collections.OrderedDict()
    try:
        for l in open(TRANSCRIPTS):
            try: r = json.loads(l)
            except Exception: continue
            if not str(r.get('ts', '')).startswith(day) or is_qa(r): continue
            sess.setdefault(r.get('session') or '?', []).append(r)
    except OSError: pass
    d = datetime.datetime.strptime(day, '%Y-%m-%d').strftime('%b %-d')
    if not sess:
        print(':busts_in_silhouette: *Activity — %s:* no customer conversations (tests excluded)' % d); return
    by_ch = collections.OrderedDict(); people = set(); orders = proposals = 0
    for sid, rows in sess.items():
        ch = rows[-1].get('channel', '?'); who = next((r.get('customer') for r in rows if r.get('customer')), '') or sid
        people.add(who)
        tools = collections.Counter(TOOL.get(r['tool'], r['tool']) for r in rows if r.get('tool') and r['tool'] != 'rachel_chat')
        turns = [r for r in rows if not r.get('tool')]
        acts = {r.get('action') for r in turns}
        ok = lambda t: any(r.get('tool') == t and not str(r.get('result') or '').startswith('ERROR') for r in rows)
        basket = max((r for r in turns if r.get('basket_items')), key=lambda r: r.get('_i', 0), default=None)
        if 'placed_order' in acts or ok('rachel_confirm_order'): end = 'order placed'; orders += 1
        elif 'generated_proposal' in acts or ok('rachel_generate_proposal'): end = 'proposal sent'; proposals += 1
        elif ok('rachel_place_order'): end = 'order prepared, not confirmed'
        elif basket: end = 'basket %d item(s), $%.2f — no order' % (basket['basket_items'], basket.get('basket_total') or 0)
        elif ok('rachel_build_package') or tools.get('search') or tools.get('recommend'): end = 'browsed — no order'
        else: end = 'no basket'
        asks = [clip(ask_of(r), 60) for r in rows if ask_of(r).strip()]
        asks = list(dict.fromkeys(asks))   # unique, in order
        size = '%d message(s)' % len(turns) if turns else '%d step(s) in Claude' % len(rows)   # connector: tool calls, not messages
        line = '• %s — %s%s → *%s*' % (who, size,
                                                 (' · ' + ', '.join('%s ×%d' % kv for kv in tools.most_common(5))) if tools else '', end)
        if asks: line += '\n     asked: ' + clip(' | '.join(asks[:4]), 200)
        by_ch.setdefault(CH.get(ch, ch), []).append(line)
    out = [':busts_in_silhouette: *Activity — %s:* %d conversation(s), %d person(s) · %d order(s), %d proposal(s) (tests excluded)'
           % (d, len(sess), len(people), orders, proposals)]
    for ch, lines in by_ch.items():
        out.append('*%s* (%d)' % (ch, len(lines))); out.extend(lines)
    print('\n'.join(out))

if __name__ == '__main__':
    main()
