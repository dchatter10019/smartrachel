#!/usr/bin/env python3
"""Rachel WhatsApp invites.  create --name N --email E [--uses 1] [--days 14] | list | revoke TOKEN"""
import json, os, sys, time, secrets, argparse
F = os.environ.get("WHATSAPP_INVITES_FILE", "/home/ubuntu/logs/whatsapp-invites.json")
BASE = os.environ.get("INVITE_BASE_URL", "https://mcp.getbevvi.com/whatsapp/invite/")
def load():
    try: return json.load(open(F))
    except Exception: return {}
def save(d):
    tmp = F + ".tmp"; json.dump(d, open(tmp, "w"), indent=1); os.replace(tmp, F)
ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd")
c = sub.add_parser("create"); c.add_argument("--name", default=""); c.add_argument("--email", default=""); c.add_argument("--uses", type=int, default=1); c.add_argument("--days", type=int, default=14); c.add_argument("--note", default=""); c.add_argument("--send", action="store_true", help="email the link to --email via rachelai@getbevvi.com")
sub.add_parser("list"); r = sub.add_parser("revoke"); r.add_argument("token")
a = ap.parse_args(); d = load()
if a.cmd == "create":
    tok = secrets.token_urlsafe(9)
    d[tok] = {"name": a.name, "email": a.email.lower(), "uses_left": a.uses, "expires": time.time() + a.days * 86400, "created": time.time(), "note": a.note, "used_by": []}
    save(d); link = BASE + tok; print(link)
    if a.send:
        if not a.email: sys.exit("--send needs --email")
        import subprocess
        first = (a.name.split()[0] if a.name else "there")
        subject = "Your invite to Rachel, Bevvi's beverage specialist"
        body = (f"Hi {first},\n\n"
                f"You're invited to Rachel — Bevvi's beverage specialist on WhatsApp. Order wine, spirits and beer, "
                f"or plan a full bar for an event, just by chatting.\n\n"
                f"Open this link on your phone to get started:\n{link}\n\n"
                f"It takes one tap: enter your mobile number, then send the access code from WhatsApp. "
                f"The link is good for {a.days} days.\n\n— The Bevvi team")
        js = "require('/home/ubuntu/rachel/email-utils.js').sendEmail(JSON.parse(process.argv[1]), process.argv[2], process.argv[3]).then(()=>console.log('sent')).catch(e=>{console.error('email failed:', e.message); process.exit(1);})"
        r = subprocess.run(["node", "-e", js, json.dumps([a.email]), subject, body], cwd="/home/ubuntu/rachel", capture_output=True, text=True)
        print(("emailed to " + a.email) if r.returncode == 0 else ("EMAIL FAILED: " + (r.stderr or r.stdout).strip()))
elif a.cmd == "list":
    for t, v in sorted(d.items(), key=lambda kv: -kv[1].get("created", 0)):
        st = "revoked" if v.get("revoked") else ("expired" if v["expires"] < time.time() else ("used" if v["uses_left"] <= 0 else "open"))
        print(f"{t:14} {st:8} uses_left={v['uses_left']} {v.get('name','')!r:20} {v.get('email','')} used_by={v.get('used_by')}")
elif a.cmd == "revoke":
    if a.token in d: d[a.token]["revoked"] = True; save(d); print("revoked")
    else: print("no such token")
else: ap.print_help()
