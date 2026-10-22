// BuildPackage v2.7.20 — BP-1..BP-13 of the 2026-10-21 change set.
// Mock-catalog tests are deterministic (exact counts); live tests run on the San Diego / airculinaire
// catalog the change set was tuned on (read-only searches). LIVE=0 skips the live ones.
import { load, run, mockFetch, liveFetch, test, eq, ok, done } from "./harness.mjs";

const fn = await load("BuildPackage.js");
const LIVE = process.env.LIVE !== "0";
const base = { kitchen_location: "San Diego - CA", client_name: "airculinaire", drinks_per_person: "0", cocktail_ingredients: "",
  hard_seltzer: "false", na_beer: "false", beer_pack_size: "12" };
const lines = (o) => JSON.parse(o.outputVars.line_items);
const qtyOf = (ls, f) => ls.filter(f).reduce((s, l) => s + l.qty, 0);
const servings = (ls, cat) => ls.filter((l) => l.category === cat).reduce((s, l) => s + l.qty * (cat === "wine" ? 5 : cat === "spirits" ? 16 : (parseInt((String(l.size) + " " + l.name).match(/(\d+)\s*x\s*\d+/i)?.[1]) || 12)), 0);
const spirits = (ls) => ls.filter((l) => l.category === "spirits");

// ---- mock catalog: a fuzzy store (a row matches on ANY word of the search, like the real API) ----
function fuzzy(rows) {
  const f = mockFetch(rows);
  return async (url) => {
    const u = new URL(url); const words = (u.searchParams.get("searchBy") || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const min = parseFloat(u.searchParams.get("min")) || 0, max = parseFloat(u.searchParams.get("max")) || 999999;
    const out = rows.filter((p) => p.price >= min && p.price <= max && words.some((w) => p.name.toLowerCase().includes(w)))
      .map((p) => ({ id: "m-" + p.name.replace(/\W+/g, "-"), slug: p.name.replace(/\W+/g, "-").toLowerCase(), ...p }));
    return { ok: true, status: 200, json: out };
  };
}
const STORE = [
  { name: "Kendall-Jackson Cabernet Sauvignon Red Wine - 750 ML", price: 18 }, { name: "Josh Cellars Merlot Red Wine - 750 ML", price: 14 },
  { name: "La Crema Chardonnay White Wine - 750 ML", price: 22 }, { name: "Kim Crawford Sauvignon Blanc White Wine - 750 ML", price: 16 },
  { name: "La Marca Prosecco Sparkling Wine - 750 ML", price: 17 }, { name: "Chandon Brut Sparkling Wine - 750 ML", price: 25 },
  { name: "Corona Extra Beer 12x12 OZ Bottle", price: 20 }, { name: "Modelo Especial Beer 24x12 OZ Can", price: 36 },
  { name: "Tito's Handmade Vodka - 750 ML", price: 22 }, { name: "Bacardi Superior White Rum - 750 ML", price: 16 },
  { name: "Maker's Mark Bourbon Whisky - 750 ML", price: 32 }, { name: "Tanqueray London Dry Gin - 750 ML", price: 26 },
  { name: "Patron Silver Tequila - 750 ML", price: 45 }, { name: "Mi Campo Blanco Tequila - 750 ML", price: 23 },
  { name: "Cointreau Triple Sec - 750 ML", price: 38 }, { name: "Disaronno Originale Amaretto - 750 ML", price: 30 },
  { name: "Canada Dry Tonic Water 1 L", price: 3 }, { name: "Canada Dry Club Soda 1 L", price: 3 }, { name: "Topo Chico Mineral Water 12 OZ", price: 2 },
  { name: "Oreo Mint Cookies 14 OZ", price: 5 }, { name: "Fresh Mint Bunch 1 OZ", price: 3 },
  { name: "Coca-Cola Zero Sugar 12 OZ", price: 2 }, { name: "Domino Pure Cane Sugar 1 LB", price: 4 },
  { name: "Rose's Sweetened Lime Juice 1 L", price: 6 },
];
const mock = () => fuzzy(STORE);
const QUOTE = "999999";

console.log("BuildPackage — mock catalog");
await test("BP-8 non-package-5 wine_lean white: red = floor(0.4 x N), white = rest", async () => {
  // package 4, 25 guests, 3 h -> 73 drinks, wine 37 -> 8 bottles -> red 3, white 5
  const o = await run(fn, { ...base, package_type: "4", guests: "25", hours: "3", total_budget: QUOTE, wine_lean: "white" }, mock());
  const ls = lines(o);
  eq(qtyOf(ls, (l) => l.label === "Red Wine"), 3, "red bottles");
  eq(qtyOf(ls, (l) => l.label === "White Wine"), 5, "white bottles");
  eq(o.outputVars.wine_heading, "WINE — 8 bottles (3 red, 5 white)", "wine_heading");
});
await test("BP-8b red lean mirrors", async () => {
  const o = await run(fn, { ...base, package_type: "4", guests: "25", hours: "3", total_budget: QUOTE, wine_lean: "red" }, mock());
  const ls = lines(o);
  eq(qtyOf(ls, (l) => l.label === "Red Wine"), 5, "red"); eq(qtyOf(ls, (l) => l.label === "White Wine"), 3, "white");
});
await test("BP-8c package 5 white lean = 50/30/20 (white/red/sparkling)", async () => {
  // 50 guests 2 h -> 113 drinks, wine 34 -> 7 bottles -> red round(2.1)=2, sparkling round(1.4)=1, white 4
  const o = await run(fn, { ...base, package_type: "5", guests: "50", hours: "2", total_budget: QUOTE, wine_lean: "white" }, mock());
  eq(o.outputVars.wine_heading, "WINE — 7 bottles (2 red, 4 white, 1 sparkling)", "wine_heading");
});
await test("BP-9 cocktail mixers: Soda Water -> plain soda (no tonic), Mint -> not a cookie, tequila = Mi Campo", async () => {
  const ci = [{ search: "Tequila", role: "base" }, { search: "Triple Sec", role: "secondary" }, { search: "Lime Juice", role: "mixer" },
    { search: "White Rum", role: "base" }, { search: "Soda Water", role: "mixer" }, { search: "Mint", role: "mixer" }];
  const o = await run(fn, { ...base, package_type: "4", guests: "40", hours: "3", total_budget: "3000", cocktail_ingredients: JSON.stringify(ci) }, mock());
  const ls = lines(o);
  const soda = ls.find((l) => l.label === "Soda Water"); ok(soda, "no Soda Water line: " + o.outputVars.unavailable);
  ok(!/tonic/i.test(soda.name), "Soda Water -> " + soda.name);
  const mint = ls.find((l) => l.label === "Mint"); ok(mint && !/oreo|cookie/i.test(mint.name), "Mint -> " + (mint && mint.name));
  ok(/mi campo/i.test(ls.find((l) => l.label === "Tequila").name), "tequila " + ls.find((l) => l.label === "Tequila").name);
  ok(!ls.some((l) => l.category === "mixers" && /coca|coke|pepsi|sprite/i.test(l.name)), "soft drink in a mixer slot");
});
await test("BP-10 'Sugar' mixer never resolves to Coca-Cola Zero Sugar", async () => {
  const ci = [{ search: "Bourbon", role: "base" }, { search: "Sugar", role: "mixer" }];
  const o = await run(fn, { ...base, package_type: "4", guests: "30", hours: "2", total_budget: QUOTE, cocktail_ingredients: JSON.stringify(ci) }, mock());
  const s = lines(o).find((l) => l.label === "Sugar");
  ok(s && /domino/i.test(s.name), "Sugar -> " + (s && s.name));
  const only = STORE.filter((p) => !/domino/i.test(p.name));
  const o2 = await run(fn, { ...base, package_type: "4", guests: "30", hours: "2", total_budget: QUOTE, cocktail_ingredients: JSON.stringify(ci) }, fuzzy(only));
  ok(!lines(o2).some((l) => /coca/i.test(l.name)), "Coca-Cola picked when it was the only 'sugar' row");
  ok(/Sugar/.test(o2.outputVars.unavailable), "Sugar should be unavailable, got: " + o2.outputVars.unavailable);
});
await test("BP-11 Mi Campo chosen although cheaper than the derived spirit floor", async () => {
  // $6,000 for 40 guests -> spirit target ~ $90 -> floor ~ $54; Mi Campo is $23
  const o = await run(fn, { ...base, package_type: "1", guests: "40", hours: "3", total_budget: "6000" }, mock());
  const t = lines(o).find((l) => l.label === "Tequila");
  ok(t && /mi campo/i.test(t.name), "tequila " + (t && t.name));
});
await test("BP-11b a customer spirit MIN above Mi Campo's price excludes it", async () => {
  const o = await run(fn, { ...base, package_type: "1", guests: "40", hours: "3", total_budget: "6000", spirit_min_price: "40" }, mock());
  const t = lines(o).find((l) => l.label === "Tequila");
  ok(t && !/mi campo/i.test(t.name), "tequila " + (t && t.name));
});
await test("BP-12 explicit percentages win over mix_bias", async () => {
  const pct = { ...base, package_type: "5", guests: "40", hours: "3", total_budget: QUOTE, wine_pct: "50", beer_pct: "30", spirit_pct: "20" };
  const a = lines(await run(fn, pct, mock())), b = lines(await run(fn, { ...pct, mix_bias: "beer>wine" }, mock()));
  for (const c of ["wine", "beer", "spirits"]) eq(servings(b, c), servings(a, c), c + " servings with bias");
});
await test("BP-12b partial percentage: unstated categories share the remainder", async () => {
  const ls = lines(await run(fn, { ...base, package_type: "5", guests: "40", hours: "3", total_budget: QUOTE, spirit_pct: "50" }, mock()));
  ok(servings(ls, "wine") > 0 && servings(ls, "beer") > 0, "wine/beer dropped");
});
await test("BP-4/5 mix_bias shifts drinks between categories (mock)", async () => {
  const p = { ...base, package_type: "5", guests: "40", hours: "3", total_budget: QUOTE };
  const bw = lines(await run(fn, { ...p, mix_bias: "beer>wine" }, mock())), wb = lines(await run(fn, { ...p, mix_bias: "wine>beer" }, mock()));
  ok(servings(bw, "beer") > servings(bw, "wine"), `beer>wine: beer ${servings(bw, "beer")} vs wine ${servings(bw, "wine")}`);
  ok(servings(wb, "wine") > servings(wb, "beer"), `wine>beer: wine ${servings(wb, "wine")} vs beer ${servings(wb, "beer")}`);
});
await test("spirit types by size (package 5): <60 drinks = 3, 60-99 = 4, >=100 = 5 (priority tequila, vodka, bourbon, gin, rum)", async () => {
  const types = async (g, h) => spirits(lines(await run(fn, { ...base, package_type: "5", guests: String(g), hours: String(h), total_budget: QUOTE }, mock()))).map((l) => l.label).sort().join(",");
  eq(await types(10, 3), "Bourbon,Tequila,Vodka", "29 drinks");
  eq(await types(25, 3), "Bourbon,Gin,Tequila,Vodka", "73 drinks");
  eq(await types(40, 3), "Bourbon,Gin,Rum,Tequila,Vodka", "116 drinks");
});
await test("v2.7.21 the gin slot never takes 'Disaronno Originale' (gin inside a word)", async () => {
  for (let i = 0; i < 2; i++) {
    const g = lines(await run(fn, { ...base, package_type: "1", guests: "40", hours: "3", total_budget: QUOTE }, mock())).filter((l) => l.label === "Gin");
    ok(g.length && g.every((l) => /tanqueray/i.test(l.name)), "gin " + g.map((l) => l.name).join(", "));
  }
});
await test("BP-13 quote mode: no errors, whole-number drinks_statement", async () => {
  const o = await run(fn, { ...base, package_type: "5", guests: "30", hours: "3", total_budget: QUOTE }, mock());
  eq(o.outputVars.success, "true", "success");
  ok(/^This package delivers about \d+ drinks per person for your 30 guests over 3 hours \(about \d+ drinks total\)\.$/.test(o.outputVars.drinks_statement), o.outputVars.drinks_statement);
  ok(/^This package is sized for about \d+ drinks per person/.test(o.outputVars.why_drinks_statement), "quote mode why: " + o.outputVars.why_drinks_statement);
});

if (LIVE) {
  console.log("\nBuildPackage — live catalog (San Diego - CA, airculinaire)");
  const live = (iv) => run(fn, { ...base, package_type: "5", ...iv }, liveFetch());
  const stmt = (o, g, h) => {
    const m = o.outputVars.drinks_statement.match(new RegExp(`^This package delivers about (\\d+) drinks per person for your ${g} guests over ${h} hours? \\(about (\\d+) drinks total\\)\\.$`));
    ok(m, "drinks_statement: " + o.outputVars.drinks_statement);
    eq(+m[2], +m[1] * g, "total = N x guests");
    return +m[1];
  };
  await test("BP-1 pkg 5, 20 guests, 2 h, $500", async () => {
    const o = await live({ guests: "20", hours: "2", total_budget: "500" });
    const sp = spirits(lines(o));
    eq(sp.map((l) => l.label).sort().join(","), "Bourbon,Tequila,Vodka", "spirit types");
    ok(/mi campo/i.test(sp.find((l) => l.label === "Tequila").name), "tequila " + sp.find((l) => l.label === "Tequila").name);
    eq(stmt(o, 20, 2), 5, "drinks per person");
    eq(o.outputVars.wine_heading, "WINE — 3 bottles (1 red, 1 white, 1 sparkling)", "wine_heading");
    ok(o.outputVars.why_drinks_statement.startsWith("Your package includes at least one bottle or pack of each type"), "why: " + o.outputVars.why_drinks_statement);
    ok(+o.outputVars.estimated_grand_total <= 500, "grand total " + o.outputVars.estimated_grand_total);
  });
  await test("BP-2 pkg 5, 40 guests, 3 h, $2500", async () => {
    const o = await live({ guests: "40", hours: "3", total_budget: "2500" });
    const sp = spirits(lines(o));
    eq(sp.length, 5, "spirit types"); ok(sp.every((l) => l.qty === 1), "1 bottle each");
    ok(/mi campo/i.test(sp.find((l) => l.label === "Tequila").name), "tequila");
    eq(o.outputVars.wine_heading, "WINE — 7 bottles (3 red, 3 white, 1 sparkling)", "wine_heading");
    stmt(o, 40, 3);
  });
  await test("BP-3 pkg 5, 80 guests, 4 h, $6000", async () => {
    const o = await live({ guests: "80", hours: "4", total_budget: "6000" });
    const sp = spirits(lines(o));
    eq(sp.length, 5, "spirit types"); eq(qtyOf(sp, () => true), 10, "spirit bottles");
    ok(/mi campo/i.test(sp.find((l) => l.label === "Tequila").name), "tequila");
    ok(/sparkling/.test(o.outputVars.wine_heading), "heading " + o.outputVars.wine_heading);
    stmt(o, 80, 4);
  });
  await test("BP-4 BP-2 + mix_bias beer>wine: beer > wine", async () => {
    const ls = lines(await live({ guests: "40", hours: "3", total_budget: "2500", mix_bias: "beer>wine" }));
    ok(servings(ls, "beer") > servings(ls, "wine"), `beer ${servings(ls, "beer")} vs wine ${servings(ls, "wine")} servings`);
  });
  await test("BP-5 BP-2 + mix_bias wine>beer: wine >> beer", async () => {
    const ls = lines(await live({ guests: "40", hours: "3", total_budget: "2500", mix_bias: "wine>beer" }));
    const wine = qtyOf(ls, (l) => l.category === "wine"), beer = qtyOf(ls, (l) => l.category === "beer");
    ok(wine >= 10 && servings(ls, "wine") > servings(ls, "beer"), `wine ${wine} bottles, beer ${beer} packs`);
  });
  await test("BP-6 BP-2 + mix_bias spirits: 10 spirit bottles, wine and beer present", async () => {
    const ls = lines(await live({ guests: "40", hours: "3", total_budget: "2500", mix_bias: "spirits" }));
    eq(qtyOf(ls, (l) => l.category === "spirits"), 10, "spirit bottles");
    ok(qtyOf(ls, (l) => l.category === "wine") > 0 && qtyOf(ls, (l) => l.category === "beer") > 0, "wine/beer missing");
  });
  await test("BP-7 pkg 5, 50 guests, 2 h, $1500, wine_lean white: red < white", async () => {
    const ls = lines(await live({ guests: "50", hours: "2", total_budget: "1500", wine_lean: "white" }));
    ok(qtyOf(ls, (l) => l.label === "Red Wine") < qtyOf(ls, (l) => l.label === "White Wine"), "red not < white");
  });
  await test("BP-13 live quote mode", async () => {
    const o = await live({ guests: "30", hours: "3", total_budget: QUOTE });
    eq(o.outputVars.success, "true", "success"); stmt(o, 30, 3);
  });
}
done();
