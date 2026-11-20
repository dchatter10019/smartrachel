# rachel/data — search alias files

<!--
GENERATED FILES — do not edit by hand. search-aliases.json and search-abbreviations.json are generated from the
Voiceflow export (Voiceflow agent transcripts, May–Nov 2026: /home/ubuntu/data/voiceflow-export/), by
/home/ubuntu/data/voiceflow-export-tools/build_rachel_alias_files.py. Created 2026-11-20 (DC).
To change them: edit the "approve" column in data/voiceflow-export/clean/alias-review.csv, then re-run the builder.
Read by rachel/search-normalize.js at service start (since Nov 20).
-->

**search-aliases.json** maps what a customer typed to the search term that found the product (e.g. "titos" →
"Tito's Vodka", "vueve" → "Veuve Clicquot"). It holds only the rows DC approved in alias-review.csv.
- These are alias-keep rows seen 3+ times: the corrected term keeps every brand word the customer typed and only adds or fixes words.
- **Whole-message match only.** The customer's entire message, normalized, must equal a key. Never match inside a longer message.

**search-abbreviations.json** expands generic shorthand that repeats across brands (chard → chardonnay, sauv blanc →
sauvignon blanc, cab → cabernet, champ → champagne, sav → sauvignon blanc, cabsav → cabernet sauvignon).
- **Whole-word match only.** Never inside a longer word. Patterns are listed longest first.

Both files carry their `normalize` rule. A reader must normalize the message the same way before matching.

**How the rows were chosen:**
1. data/voiceflow-export-tools/alias_candidates.py found the candidates.
2. alias_sort.py sorted them into keep / demand gaps / reject. Rejected:
   - corrections that drop the brand, or a distinguishing word such as a region, style or cuvée;
   - follow-ups that name no product;
   - corrections to a different brand.
3. DC reviewed alias-review.csv.

**Hand-edited (not generated):**
- **search-category-words.json** — the ONLY words the zero-result spell check may correct a typed word to (prosecco,
  chardonnay, tequila...). 5+ letters. No brand words, nothing learned from searches.
- **search-normalize-config.json** — off switch: `abbreviations` / `aliases` / `spellcheck` true|false, read once at
  service start. Set one to false and restart (precheck.sh --deploy) to turn that layer off with no code change.
