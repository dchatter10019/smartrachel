// Static checks that the Voiceflow prompt carries every 6.37 -> 6.45 rule of the 2026-10-21 change set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, ok, done } from "./harness.mjs";

const P = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rachel-prompt.md"), "utf8");
const has = (s, what) => ok(P.includes(s), "missing: " + (what || s));

console.log("Prompt");
await test("6.37/6.38 no reasoning text; build_text pasted verbatim on first build", async () => {
  has("NEVER write your reasoning, notes or commentary to the customer");
  has("your ENTIRE text before calling [BuildPackage] is the build_text output pasted word for word");
});
await test("6.39 wine_lean passed through", async () => has("wine_lean: pass the wine_lean output of [ParseRequest] EXACTLY"));
await test("6.40 bartender quote: exact reply + one email to bevvi-support and the customer, no staffing question", async () => {
  has("I'm not able to provide bartender pricing myself, but I've alerted Bevvi Support and someone from the team will contact you with more information.");
  has('To: "bevvi-support@getbevvi.com, {user_email}"');
  has('Subject: "Bartender Quote Request: [guests] guests - {kitchen_location}"');
  has("do NOT ask the Step 4 question");
});
await test("6.41 relative mix wishes are mix_bias, not percentages", async () => {
  has("are NOT percentages");
  has("mix_bias: pass the mix_bias output of [ParseRequest] EXACTLY");
});
await test("6.42/6.43 drinks statement only; why_drinks_statement only when asked; upgrade-or-keep", async () => {
  has("reply with the `why_drinks_statement` output");
  has("NEVER show `why_drinks_statement` unless the customer asks");
  has("want me to upgrade to premium selections or keep it as is?");
  ok(!/add more quantity/i.test(P), "'add more quantity' still offered");
  has('"more" / "bigger" → treat exactly like "upgrade"');
});
await test("6.44 WINE heading = wine_heading verbatim", async () => has("**[wine_heading output, pasted verbatim]**"));
await test("6.45 exact markdown: bold headings/totals and a literal ☐ per product line", async () => {
  has("**Wine total: $[amount]**"); has("**Estimated grand total: $[estimated_grand_total]**"); has("**Add All Items to Cart**");
  ok((P.match(/^☐ \[qty\]x/gm) || []).length >= 5, "☐ product lines");
});
await test("version command matches the change set (v6.45)", async () => {
  ok(/Build v6\.45\b/.test(P) && /\(v6\.45\)/.test(P), "prompt still announces " + (P.match(/Build v[\d.]+/) || ["?"])[0] + " — the change set says v6.45; /version will report the old number");
});
done();
