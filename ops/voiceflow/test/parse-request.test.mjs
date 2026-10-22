// ParseRequest v1.4 — change set 2026-10-21, tests PR-1..PR-8 (+ regressions).
import { load, test, eq, ok, done } from "./harness.mjs";

const fn = await load("ParseRequest.js");
const parse = async (text) => (await fn({ inputVars: { customer_text: text } })).outputVars;
const BUILD_TEXT = "Great — I've got everything I need! I'm building your custom package now — this usually takes under a minute, so hang tight and I'll drop the full breakdown right here.";

console.log("ParseRequest");
await test("PR-1 'No mocktails' is not a request; BUILD with build_text", async () => {
  const o = await parse("need a menu for 40 people, 3 hour party, beer wine and spirits, budget $2500. No mocktails");
  eq(o.mocktails_requested, "false", "mocktails_requested");
  eq(o.next_action, "BUILD", "next_action");
  eq(o.build_text, BUILD_TEXT, "build_text");
  eq(o.hours_detected, "3", "hours_detected");
});
for (const neg of ["without mocktails", "we don't need mocktails", "skip the mocktails", "no mock-tails please", "do not want any mocktails"]) {
  await test(`PR-1b negation: "${neg}"`, async () => {
    const o = await parse(`30 guests, 2 hours, beer and wine, ${neg}`);
    eq(o.mocktails_requested, "false", "mocktails_requested");
    eq(o.next_action, "BUILD", "next_action");
  });
}
await test("PR-2 'mocktails please' is still a request (asks which)", async () => {
  const o = await parse("50 guests for 3 hours, wine and beer, mocktails please");
  eq(o.mocktails_requested, "true", "mocktails_requested");
  eq(o.next_action, "ASK_MOCKTAILS", "next_action");
  eq(o.build_text, "", "build_text only on BUILD");
});
await test("PR-2b named mocktails -> mixers JSON, BUILD", async () => {
  const o = await parse("50 guests for 3 hours, wine and beer, plus virgin mojitos and shirley temples");
  eq(o.mocktails_requested, "true", "mocktails_requested");
  eq(o.next_action, "BUILD", "next_action");
  const mix = JSON.parse(o.mocktail_mixers_json).map((m) => m.search);
  ok(mix.includes("Club Soda") && mix.includes("Grenadine"), "mixers " + mix.join(","));
});
await test("PR-2c 'no mocktails' + a named mocktail later still counts", async () => {
  const o = await parse("40 guests, 2 hours. no mocktails. actually add virgin mojitos");
  eq(o.mocktails_requested, "true", "mocktails_requested");
});
for (const [txt, want] of [["I want more white than red", "white"], ["mostly white please", "white"], ["white-heavy wine", "white"],
  ["more red than white", "red"], ["mostly red", "red"], ["red over white", "red"], ["just wine", ""]]) {
  await test(`PR-3 wine_lean: "${txt}" -> "${want}"`, async () => eq((await parse("40 guests 3 hours " + txt)).wine_lean, want, "wine_lean"));
}
for (const [id, txt, want] of [
  ["PR-4", "I want more beer than wine", "beer>wine"],
  ["PR-5", "I want more wine than beer", "wine>beer"],
  ["PR-6", "Please add more liquor, heavy on the spirits", "spirits"],
  ["PR-7", "40% wine, 30% beer, more beer than wine", ""],
  ["PR-8", "spirits-heavy please", "spirits"],
  ["PR-6b", "I want it heavy on the spirits", "spirits"],
  ["PR-6c", "heavy on the beer please", "beer"],
  ["PR-4b", "beer over wine", "beer>wine"],
  ["PR-x", "beer, wine and spirits", ""],
]) {
  await test(`${id} mix_bias: "${txt}" -> "${want}"`, async () => eq((await parse("40 guests, 3 hour party, budget $2500. " + txt)).mix_bias, want, "mix_bias"));
}
await test("hours: 'from 5 to 7 pm' = 2", async () => eq((await parse("party from 5 to 7 pm, 30 guests")).hours_detected, "2", "hours"));
await test("no hours -> ASK_HOURS", async () => {
  const o = await parse("30 guests beer and wine $800");
  eq(o.next_action, "ASK_HOURS", "next_action");
  eq(o.ask_text, "How many hours will your event run?", "ask_text");
});
done();
