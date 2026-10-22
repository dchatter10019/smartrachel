// Runs a Voiceflow function file (export default async function main(args)) in Node.
// Voiceflow's fetch exposes .json as a PROPERTY, not a method; the shim reproduces that.
//   live  — real catalog (api.getbevvi.com searchCorpProducts, read-only)
//   mock  — an in-memory catalog: a row matches when every word of searchBy is in its name
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realFetch = globalThis.fetch;

export async function load(file) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8");
  const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
  return mod.default;
}

export function liveFetch() {
  return async (url) => {
    const r = await realFetch(url);
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    return { ok: r.ok, status: r.status, json };
  };
}

// rows: [{ name, price, size?, units? }]
export function mockFetch(rows, calls) {
  return async (url) => {
    const u = new URL(url);
    const term = (u.searchParams.get("searchBy") || "").toLowerCase();
    const min = parseFloat(u.searchParams.get("min")) || 0;
    const max = parseFloat(u.searchParams.get("max")) || 999999;
    if (calls) calls.push({ term, min, max });
    const words = term.split(/\s+/).filter(Boolean);
    const out = rows.filter((p) => {
      const price = p.salePrice || p.price;
      const n = p.name.toLowerCase();
      return price >= min && price <= max && words.every((w) => n.includes(w));
    }).map((p, i) => ({ id: "mock-" + i + "-" + p.name.replace(/\W+/g, "-"), slug: p.name.replace(/\W+/g, "-").toLowerCase(), ...p }));
    return { ok: true, status: 200, json: out };
  };
}

export async function run(fn, inputVars, fetchImpl) {
  globalThis.fetch = fetchImpl;
  try { return await fn({ inputVars }); } finally { globalThis.fetch = realFetch; }
}

// tiny test runner
const results = [];
export async function test(id, body) {
  const t0 = Date.now();
  try { await body(); results.push({ id, ok: true, ms: Date.now() - t0 }); console.log(`  ✓ ${id} (${Date.now() - t0}ms)`); }
  catch (e) { results.push({ id, ok: false, err: e.message }); console.log(`  ✗ ${id}: ${e.message}`); }
}
export function eq(got, want, what) { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
export function ok(cond, what) { if (!cond) throw new Error(what); }
export function done() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}
