// SearchProducts v2.6 — SP-1 / SP-2 (Mi Campo ignores min_price, honours max_price).
import { load, run, mockFetch, liveFetch, test, eq, ok, done } from "./harness.mjs";

const fn = await load("SearchProducts.js");
const ROWS = [
  { name: "Patron Silver Tequila - 750 ML", price: 45, size: 750, units: "ML" },
  { name: "Don Julio Blanco Tequila - 750 ML", price: 52, size: 750, units: "ML" },
  { name: "Mi Campo Blanco Tequila - 750 ML", price: 23, size: 750, units: "ML" },
];
const base = { kitchen_location: "San Diego - CA", client_name: "airculinaire", top_n: "3" };
const results = (o) => JSON.parse(o.outputVars.results);

console.log("SearchProducts");
await test("SP-1 generic Tequila, min_price above Mi Campo -> Mi Campo still returned, first (mock)", async () => {
  const o = await run(fn, { ...base, queries: JSON.stringify([{ label: "tequila", term: "Tequila", min_price: 35 }]) }, mockFetch(ROWS));
  const p = results(o)[0].products;
  ok(/mi campo/i.test(p[0].name), "first product " + p[0].name);
  ok(p.every((x) => /mi campo/i.test(x.name) || x.price >= 35), "other rows respect min_price");
});
await test("SP-2 generic Tequila, max_price below Mi Campo -> Mi Campo excluded (mock)", async () => {
  const o = await run(fn, { ...base, queries: JSON.stringify([{ label: "tequila", term: "Tequila", max_price: 20 }]) }, mockFetch(ROWS));
  ok(!results(o)[0].products.some((x) => /mi campo/i.test(x.name)), "Mi Campo shown");
});
await test("SP-3 branded tequila (Patron) is left alone — no Mi Campo merged (mock)", async () => {
  const o = await run(fn, { ...base, queries: JSON.stringify([{ label: "patron", term: "Patron Tequila" }]) }, mockFetch(ROWS));
  ok(!results(o)[0].products.some((x) => /mi campo/i.test(x.name)), "Mi Campo merged into a branded search");
});
await test("SP-1 live (San Diego): Tequila min_price 30 -> Mi Campo first", async () => {
  const o = await run(fn, { ...base, queries: JSON.stringify([{ label: "tequila", term: "Tequila", min_price: 30 }]) }, liveFetch());
  const p = results(o)[0].products;
  ok(p.length > 0 && /mi campo/i.test(p[0].name), "first product " + (p[0] && p[0].name));
});
await test("SP-2 live (San Diego): Tequila max_price 15 -> no Mi Campo", async () => {
  const o = await run(fn, { ...base, queries: JSON.stringify([{ label: "tequila", term: "Tequila", max_price: 15 }]) }, liveFetch());
  ok(!results(o)[0].products.some((x) => /mi campo/i.test(x.name)), "Mi Campo shown");
});
done();
