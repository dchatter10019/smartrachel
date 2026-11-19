#!/usr/bin/env python3
"""Label, scrub and summarise exported Voiceflow transcripts. Deterministic, no model calls.

  rachel/venv/bin/python rachel/data/vf_clean.py

Reads  /home/ubuntu/data/voiceflow-export/raw/*.json (one at a time; never all in memory).
Writes /home/ubuntu/data/voiceflow-export/labels.csv            every transcript: id, date, label, reason
       /home/ubuntu/data/voiceflow-export/clean/conversations.jsonl  scrubbed REAL conversations
       /home/ubuntu/data/voiceflow-export/clean/requests.csv         one row per customer product request
       /home/ubuntu/data/voiceflow-export/clean/report.md
labels.csv sits OUTSIDE clean/ because a test reason names the email domain. Nothing is deleted.

Labels (first rule that fires):
  empty - no user message at all
  test  - sessionID starts dc-test / claude-debug / qa-; user_email @getbevvi.com / @geotechinfo.net;
          creatorURL in project 69156ae182986ddbff0a9121 (dev); or every user message is keyboard mash
  no_request - every user message is only a greeting or "test" (hi, hello, hey, test, testing; case and
          punctuation ignored)
  real  - everything else

A "request" = a user message after which Rachel called a search tool (SearchProducts / get_product_url) before the
next user message. Its window runs until the next such message (so "add it" / "2 bottles" stay with it).
  outcome added_to_cart  - an add-to-cart tool call in the window whose result succeeded
          not_available  - otherwise, Rachel showed no product, or her reply says the item isn't available
          no_follow_up   - otherwise
"""
import collections
import csv
import datetime as dt
import glob
import json
import os
import re

OUT = "/home/ubuntu/data/voiceflow-export"
RAW = os.path.join(OUT, "raw")
CLEAN = os.path.join(OUT, "clean")
DEV_PROJECT = "/project/69156ae182986ddbff0a9121/"
TEST_SESSION = ("dc-test", "claude-debug", "qa-")
TEST_DOMAINS = ("@getbevvi.com", "@geotechinfo.net")
SEARCH_TOOLS = {"searchproducts", "search_products", "get_product_url", "getproducturl"}
ADD_TOOLS = {"addtocart", "add_to_cart"}
OLD_SEARCH = {"get_product_url", "getproducturl"}       # until ~July: one product name per call
NEW_SEARCH = {"searchproducts", "search_products"}      # from ~August: term + fallback_terms
GREETINGS = {"hi", "hello", "hey", "test", "testing"}


def is_greeting(msg):
    return re.sub(r"[^a-z]", "", (msg or "").lower()) in GREETINGS

# ---------------------------------------------------------------- scrubbing
EMAIL = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
ORDER = re.compile(r"\bBEVVI-[A-Za-z0-9-]+", re.I)
# Air Culinaire's own order numbers ("ADD TO THIS ORDER B000495196"), Nov 19
CLIENT_ORDER = re.compile(r"\bB\d{7,}\b")
PHONE = re.compile(r"(?<![\w$.])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w.])")
# "St" / "Dr" are also name prefixes on bottles (St-Germain, St. Supery, Dr. Loosen): as a street type they must
# not be followed by another word, unless it is a unit / direction word. A count ("2 bottles St Germain") is not
# a house number.
STREET_TYPES = (r"St(?!\.?[\s-]+(?!(?:Suite|Ste|Apt|Unit|Hangar|NW|NE|SW|SE|N|S|E|W)\b)[A-Za-z])|"
                r"Dr(?!\.?[\s-]+(?!(?:Suite|Ste|Apt|Unit|Hangar|NW|NE|SW|SE|N|S|E|W)\b)[A-Za-z])|"
                r"Street|Ave|Avenue|Av|Rd|Road|Blvd|Boulevard|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|"
                r"Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle|Sq|Square|Loop|Trl|Trail|Plaza|Plz|Broadway")
QTY_WORD = r"(?!(?:bottles?|btls?|cases?|cs|cans?|packs?|pk|x|of|ml|l|lt|oz|liters?|litres?|cl|ct|more|each)\b)"
ADDRESS = re.compile(
    r"\b\d{1,6}[A-Za-z]?\s+" + QTY_WORD + r"(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9.'-]+\s+){0,4}(?:" + STREET_TYPES + r")\b\.?"
    r"(?:\s*,?\s*(?:Suite|Ste|Apt|Unit|Hangar|#)\s*[\w-]+)?"
    r"(?:\s*,\s*[A-Za-z .]+,?\s+[A-Z]{2}\.?(?:\s+\d{5}(?:-\d{4})?)?)?", re.I)


def scrub(text):
    if not text:
        return text
    text = EMAIL.sub("[EMAIL]", text)
    text = ORDER.sub("[ORDER]", text)
    text = CLIENT_ORDER.sub("[ORDER]", text)
    text = ADDRESS.sub("[ADDRESS]", text)
    text = PHONE.sub("[PHONE]", text)
    return text


# ---------------------------------------------------------------- keyboard mash
ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890")


def is_mash(msg):
    """A message that is keyboard mash: one short token, letters only, that a person did not mean as words."""
    s = (msg or "").strip().lower()
    if not s or " " in s or len(s) < 3 or len(s) > 30 or not s.isalpha():
        return False
    if not re.search(r"[aeiouy]", s):                       # "sdfgh", "jkl"
        return True
    if re.search(r"[^aeiouy]{5,}", s):                       # 5+ consonants in a row
        return True
    if len(set(s)) <= 2 and len(s) >= 4:                     # "asasas", "aaaa"
        return True
    for row in ROWS:                                         # 4+ keys in a keyboard-row run: "asdf", "qwer"
        for i in range(len(row) - 3):
            if row[i:i + 4] in s or row[i:i + 4][::-1] in s:
                return True
    return False


# ---------------------------------------------------------------- reading a transcript
def unq(v):
    try:
        v = json.loads(v)
    except (TypeError, ValueError):
        pass
    return "" if v is None else str(v)


def variables(turns):
    out = {}
    for t in turns:
        if t.get("event") == "variables_changed":
            for ch in t.get("changes") or []:
                out[ch.get("name")] = unq(ch.get("after"))
    return out


def tool_name(x):
    return (x.get("toolName") or x.get("name") or "").strip().lower()


def search_terms(x):
    a = x.get("arguments") or {}
    terms = []
    if a.get("product_name"):
        terms.append(str(a["product_name"]))
    q = a.get("queries")
    if isinstance(q, str):
        try:
            q = json.loads(q)
        except ValueError:
            terms.append(q)
            q = None
    for e in q or []:
        if isinstance(e, dict):
            terms += [str(e.get("term") or "")] + [str(f) for f in (e.get("fallback_terms") or [])]
        elif e:
            terms.append(str(e))
    return [t for t in terms if t.strip()]


PRICE = re.compile(r"\$\s?\d[\d,]*(?:\.\d{1,2})?")
NOT_PRODUCT = re.compile(r"^(sub)?total|^tax|^estimated|^delivery|^service|^tip|^grand|^budget|^cart|^order", re.I)
SIZE_SEG = re.compile(r"^\s*(\d+(\.\d+)?\s*(ml|l|lt|liter|litre|oz|fl oz|cl)|\d+\s*(pk|pack|ct)|\d+\s*x\s*\d+.*)\s*$", re.I)
UNAVAILABLE = re.compile(
    r"isn'?t available|is not available|not available at|aren'?t available|are not available|couldn'?t find|"
    r"could not find|wasn'?t able to find|unable to find|don'?t (?:currently )?(?:have|carry)|do not (?:have|carry)|"
    r"not (?:currently )?carried|no (?:results|matches)|out of stock|doesn'?t (?:carry|have)", re.I)


def products_in(reply):
    names = []
    for line in (reply or "").split("\n"):
        if not PRICE.search(line) or ("—" not in line and " - " not in line):
            continue
        head = PRICE.split(line, 1)[0]
        head = re.sub(r"[\s—–-]+$", "", head)                       # separator before the price
        head = re.sub(r"^\s*(?:\d+[.)]|[-*•☐☑✅⭐]+|\s)+", "", head)  # list markers
        head = head.replace("**", "").replace("⭐", "").strip()
        if "—" in head:
            head = head.split("—", 1)[0].strip()
        else:
            segs = [s for s in head.split(" - ")]
            while len(segs) > 1 and SIZE_SEG.match(segs[-1]):
                segs.pop()
            head = " - ".join(segs).strip()
        head = head.rstrip(":").strip()
        if len(head) < 2 or NOT_PRODUCT.search(head):
            continue
        names.append(head)
    return names


def requests_of(turns, tool_results):
    """Split the conversation into product requests (see module doc)."""
    users = [i for i, t in enumerate(turns) if t.get("role") == "user"]
    starts = []
    for k, ui in enumerate(users):
        end = users[k + 1] if k + 1 < len(users) else len(turns)
        calls = [x for t in turns[ui:end] if t.get("event") == "tool_call" for x in t.get("tools") or []]
        if any(tool_name(x) in SEARCH_TOOLS for x in calls):
            starts.append(ui)
    out = []
    for k, si in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(turns)
        nxt_user = next((u for u in users if u > si), len(turns))
        window = turns[si:end]
        terms, shown, replies, added, tools = [], [], [], False, set()
        for t in turns[si:nxt_user]:                     # the search + Rachel's answer to THIS message
            if t.get("event") == "tool_call":
                for x in t.get("tools") or []:
                    if tool_name(x) in SEARCH_TOOLS:
                        terms += search_terms(x)
                        tools.add(tool_name(x))
            if t.get("role") == "agent":
                replies.append(t.get("message") or "")
                shown += products_in(t.get("message"))
        t0 = turns[si].get("time") or ""
        t1 = turns[end].get("time") if end < len(turns) else "9999"
        for t in window:
            if t.get("event") == "tool_call" and any(tool_name(x) in ADD_TOOLS for x in t.get("tools") or []):
                ok = [r for r in tool_results
                      if r["add"] and t0 <= r["time"] < (t1 or "9999") and r["ok"]]
                added = added or bool(ok)
        if added:
            outcome = "added_to_cart"
        elif not shown or any(UNAVAILABLE.search(r) for r in replies):
            outcome = "not_available"
        else:
            outcome = "no_follow_up"
        out.append({"customer_text": turns[si].get("message") or "",
                    "search_terms": list(dict.fromkeys(terms)),
                    "products_shown": list(dict.fromkeys(shown)), "outcome": outcome,
                    "tool_era": ("mixed" if tools & OLD_SEARCH and tools & NEW_SEARCH
                                 else "old" if tools & OLD_SEARCH else "new")})
    return out


def results_of(d):
    res = []
    for r in d.get("toolCalls") or []:
        name = (r.get("tool") or "").lower()
        out = r.get("outputVars") or {}
        ok = "succeeded" in name and str(out.get("success", "true")).lower() != "false" and not out.get("error")
        res.append({"add": "addtocart" in name.replace("_", "").replace('"', ""), "time": r.get("time") or "", "ok": ok})
    return res


def label(meta, vars_, users):
    sid = meta.get("sessionID") or ""
    email = (vars_.get("user_email") or "").lower()
    if not users:
        return "empty", "no user message"
    for p in TEST_SESSION:
        if sid.startswith(p):
            return "test", f"sessionID starts {p}"
    for dom in TEST_DOMAINS:
        if email.endswith(dom):
            return "test", f"user_email domain {dom.lstrip('@')}"
    if DEV_PROJECT in (meta.get("creatorURL") or ""):
        return "test", "creatorURL is the dev project ...9121"
    if all(is_mash(u) for u in users):
        return "test", "only keyboard mash: " + " / ".join(u.strip() for u in users)[:120]
    if all(is_greeting(u) for u in users):
        return "no_request", "only greetings / test: " + " / ".join(u.strip() for u in users)[:120]
    return "real", ""


# ---------------------------------------------------------------- main
def main():
    os.makedirs(CLEAN, exist_ok=True)
    files = sorted(glob.glob(os.path.join(RAW, "*.json")))
    labels = collections.Counter()
    reasons = collections.Counter()
    month = collections.Counter()
    kitchen = collections.Counter()
    client = collections.Counter()
    outcomes = collections.Counter()
    texts = collections.Counter()
    spelling = {}
    real_domains = collections.Counter()
    by_month = collections.defaultdict(collections.Counter)
    by_era = collections.defaultdict(collections.Counter)
    unreadable = 0
    n_req = 0
    with open(os.path.join(OUT, "labels.csv"), "w", newline="") as lf, \
            open(os.path.join(CLEAN, "conversations.jsonl"), "w") as cf, \
            open(os.path.join(CLEAN, "requests.csv"), "w", newline="") as rf:
        lw = csv.writer(lf)
        lw.writerow(["transcript_id", "date", "label", "reason"])
        rw = csv.writer(rf)
        rw.writerow(["transcript_id", "date", "client_id", "kitchen_location", "customer_text", "search_terms",
                     "products_shown", "outcome", "tool_era"])
        for f in files:
            tid = os.path.basename(f)[:-5]
            try:
                with open(f) as fh:
                    d = json.load(fh)
            except ValueError as e:
                unreadable += 1
                lw.writerow([tid, "", "unreadable", f"bad JSON: {e}"])
                continue
            meta = d.get("transcript") or d.get("_search_row") or {}
            turns = d.get("turns") or []
            vars_ = variables(turns)
            users = [t.get("message") or "" for t in turns if t.get("role") == "user"]
            date = (meta.get("createdAt") or "")[:10]
            lab, why = label(meta, vars_, users)
            labels[lab] += 1
            lw.writerow([tid, date, lab, why])
            if lab != "real":
                reasons[f"{lab}: {re.sub(r':.*', '', why)}"] += 1
                continue
            cid, kl = vars_.get("client_id", ""), vars_.get("kitchen_location", "")
            em = vars_.get("user_email") or ""
            real_domains[em.split("@")[-1].lower() if "@" in em else "(none)"] += 1
            month[date[:7]] += 1
            kitchen[kl or "(none)"] += 1
            client[cid or "(none)"] += 1
            conv = {"id": tid, "date": date, "client_id": cid, "kitchen_location": kl,
                    "turns": [{"role": t["role"], "time": t.get("time"), "text": scrub(t.get("message") or "")}
                              for t in turns if t.get("role") in ("user", "agent")]}
            cf.write(json.dumps(conv, ensure_ascii=False) + "\n")
            for r in requests_of(turns, results_of(d)):
                txt = scrub(r["customer_text"])
                rw.writerow([tid, date, cid, kl, txt, " | ".join(scrub(t) for t in r["search_terms"]),
                             " | ".join(scrub(p) for p in r["products_shown"]), r["outcome"], r["tool_era"]])
                n_req += 1
                outcomes[r["outcome"]] += 1
                by_month[date[:7]][r["outcome"]] += 1
                by_era[r["tool_era"]][r["outcome"]] += 1
                key = " ".join(txt.lower().split())
                texts[key] += 1
                spelling.setdefault(key, txt.strip())

    total = len(files)
    L = ["# Voiceflow conversation export — summary", "",
         f"Generated {dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} from {total} raw transcripts "
         "(project 69156ae182986ddbff0a9120). Deterministic rules only; see rachel/data/vf_clean.py.", "",
         "## Labels", "",
         f"- **real**: {labels['real']}", f"- **empty** (greeting only, no customer message): {labels['empty']}",
         f"- **test**: {labels['test']}",
         f"- **no_request** (only greetings or 'test': hi, hello, hey, test, testing): {labels['no_request']}"]
    if unreadable:
        L.append(f"- **unreadable** (bad JSON, skipped): {unreadable}")
    L += ["", "Why each non-real transcript was set aside:", ""]
    L += [f"- {k}: {v}" for k, v in reasons.most_common()]
    L += ["", "Customer email domains among the real conversations (emails themselves dropped):", ""]
    L += [f"- {k}: {v}" for k, v in real_domains.most_common()]
    L += ["", "## Real conversations per month", "", "| Month | Conversations |", "|---|---:|"]
    L += [f"| {k} | {v} |" for k, v in sorted(month.items())]
    L += ["", "## Real conversations per client", "", "| client_id | Conversations |", "|---|---:|"]
    L += [f"| {k} | {v} |" for k, v in client.most_common()]
    L += ["", "## Real conversations per kitchen_location", "", "| Kitchen | Conversations |", "|---|---:|"]
    L += [f"| {k} | {v} |" for k, v in kitchen.most_common()]
    L += ["", "## How product requests ended", "", f"{n_req} product requests (a customer message that made Rachel "
          "search the catalog).", "", "| Outcome | Requests | Share |", "|---|---:|---:|"]
    L += [f"| {k} | {v} | {v / max(n_req, 1):.0%} |" for k, v in outcomes.most_common()]
    L += ["", "- added_to_cart: an add-to-cart call succeeded before the customer's next search request",
          "- not_available: Rachel showed no product, or said the item isn't available",
          "- no_follow_up: products were shown and nothing was added", ""]
    OUTS = ("added_to_cart", "not_available", "no_follow_up")

    def table(title, first, groups, keys):
        rows = ["", f"### {title}", "", f"| {first} | " + " | ".join(OUTS) + " | Total |",
                "|---|" + "---:|" * (len(OUTS) + 1)]
        for k in keys:
            c = groups[k]
            n = sum(c.values())
            rows.append(f"| {k} | " + " | ".join(f"{c[o]} ({c[o] / max(n, 1):.0%})" for o in OUTS) + f" | {n} |")
        return rows
    L += table("By month", "Month", by_month, sorted(by_month))
    L += table("By tool era", "tool_era", by_era, [e for e in ("old", "new", "mixed") if e in by_era])
    L += ["", "- old: Rachel searched with get_product_url (one product name per call; until ~July)",
          "- new: Rachel searched with SearchProducts (term + fallback terms; from ~August)"]
    if "mixed" in by_era:
        L.append("- mixed: both tools were called for the same request")
    L += ["",
          "## 50 most common customer requests", "",
          "Grouped ignoring case and spacing; personal data already scrubbed.", "", "| # | Customer text | Times |",
          "|---:|---|---:|"]
    for i, (k, v) in enumerate(texts.most_common(50), 1):
        L.append(f"| {i} | {spelling[k].replace('|', '/').replace(chr(10), ' ')[:120]} | {v} |")
    with open(os.path.join(CLEAN, "report.md"), "w") as fh:
        fh.write("\n".join(L) + "\n")
    print(f"files {total}: " + ", ".join(f"{k} {v}" for k, v in labels.most_common()) +
          (f", unreadable {unreadable}" if unreadable else "") + f" | requests {n_req}: " +
          ", ".join(f"{k} {v}" for k, v in outcomes.most_common()))
    for k, v in reasons.most_common():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
