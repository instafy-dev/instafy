// Research handoff files without the map pack (a shopping team run): a shopping team's lanes checked their product files
// with the map pack's `uw handoff --check`, so a shopping job loaded the map skill. `instafy web handoff` is the
// generic check: the schema for one file, and a folder's prices read again on their pages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkHandoff, pageShowsPrice } from "../src/research.mjs";
import { runWebCommand } from "../src/web.mjs";

const sink = () => ({ text: "", write(t) { this.text += t; } });
const product = (over = {}) => ({
  schema: "instafy.research@1", item: "HOKA Arahi", kind: "product", model: "Arahi 7", summary: "Stability shoe.",
  facts: [{ text: "5 mm drop", source_url: "https://maker.test/arahi", retrieved_at: "2026-10-19", confidence: "high" }],
  places: [{ name: "Fleet Feet", kind: "store", source_url: "https://shop.test/arahi-7" }],
  prices: [{ store: "Fleet Feet", amount: 108.75, currency: "USD", kind: "sale", source_url: "https://shop.test/arahi-7", retrieved_at: "2026-10-19" }],
  unknowns: ["check: ASICS price (refused automated reads)"],
  ...over,
});

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

test("--check accepts a product file and lists what to fix, with no network", async () => {
  const dir = folder({ "arahi.json": product(), "bad.json": product({ schema: "x", prices: [{ amount: "150" }] }) });
  const out = sink();
  assert.equal(await runWebCommand(["handoff", "--check", path.join(dir, "arahi.json")], { stdout: out, stderr: sink(), fetchImpl: () => { throw new Error("no network"); } }), 0);
  assert.match(out.text, /usable \(1 place\(s\), 1 sourced fact\(s\), 0 leg\(s\), 1 sourced price\(s\)\)/);
  const bad = sink();
  assert.equal(await runWebCommand(["handoff", "--check", path.join(dir, "bad.json")], { stdout: bad, stderr: sink() }), 1);
  assert.match(bad.text, /NOT usable/);
  assert.match(bad.text, /expected "instafy.research@1"/);
  assert.match(bad.text, /prices\[0\]\.amount must be a number/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a city file without a country, or a cluster lane without stops, is told what to add", () => {
  const city = checkHandoff({ schema: "instafy.research@1", item: "Hualien and Taitung", kind: "city", places: [{ name: "Some Hotel", kind: "hotel" }] });
  assert.ok(city.ok);
  assert.ok(city.errors.some((e) => /no "country"/.test(e)));
  assert.ok(city.errors.some((e) => /put "stop": "<City>"/.test(e)));
});

test("a folder's prices are read again: one still on its page, one the page no longer shows", async () => {
  const dir = folder({
    "arahi.json": product(),
    "gts.json": product({ item: "Brooks Adrenaline GTS", model: "GTS 24", prices: [{ store: "Shop", amount: 109.95, currency: "USD", source_url: "https://shop.test/gts-24", retrieved_at: "2026-10-19" }] }),
    "notes.txt": "ignored",
  });
  const pages = {
    "https://shop.test/robots.txt": { status: 404, body: "" },
    "https://shop.test/arahi-7": { status: 200, body: "<title>Arahi 7</title><p>Now $108.75 (was $145.00)</p>" },
    "https://shop.test/gts-24": { status: 200, body: "<title>GTS 24</title><p>Now $119.95</p>" },
  };
  const fetchImpl = async (url) => {
    const page = pages[url] || { status: 404, body: "" };
    return { ok: page.status < 300, status: page.status, url, headers: { "content-type": "text/html" }, text: async () => page.body };
  };
  const out = sink();
  assert.equal(await runWebCommand(["handoff", dir, "--json"], { stdout: out, stderr: sink(), fetchImpl, allowLocal: true }), 0);
  const result = JSON.parse(out.text);
  assert.equal(result.items.length, 2);
  const byItem = Object.fromEntries(result.prices.map((p) => [p.item, p]));
  assert.equal(byItem["HOKA Arahi"].checked, true);
  assert.equal(byItem["Brooks Adrenaline GTS"].stale, true);
  assert.deepEqual(result.recheck, { status: "ok", pages: 2, read: 2, skipped: 0, checked: 1, stale: 1, unavailable: 0, unavailable_sites: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a store that does not answer leaves its price unconfirmed, never stale: the re-check is partial", async () => {
  const dir = folder({
    "arahi.json": product(),
    "gts.json": product({ item: "Brooks Adrenaline GTS", model: "GTS 24", prices: [{ store: "Down", amount: 109.95, currency: "USD", source_url: "https://down.test/gts-24", retrieved_at: "2026-10-19" }] }),
  });
  const pages = {
    "https://shop.test/robots.txt": { status: 404, body: "" },
    "https://shop.test/arahi-7": { status: 200, body: "<p>Now $108.75</p>" },
  };
  const fetchImpl = async (url) => {
    if (url.startsWith("https://down.test/")) throw Object.assign(new Error("could not read down.test: connect ECONNREFUSED"), { code: "upstream" });
    const page = pages[url] || { status: 404, body: "" };
    return { ok: page.status < 300, status: page.status, url, headers: { "content-type": "text/html" }, text: async () => page.body };
  };
  const out = sink();
  assert.equal(await runWebCommand(["handoff", dir, "--json"], { stdout: out, stderr: sink(), fetchImpl, allowLocal: true }), 0);
  const result = JSON.parse(out.text);
  const gts = result.prices.find((p) => p.item === "Brooks Adrenaline GTS");
  assert.equal(gts.stale, undefined, "a store that is down says nothing about the price");
  assert.equal(gts.unchecked, "unavailable");
  assert.equal(result.status, "partial");
  assert.deepEqual([result.recheck.unavailable, result.recheck.unavailable_sites], [1, ["down.test"]]);
  const text = sink();
  await runWebCommand(["handoff", dir], { stdout: text, stderr: sink(), fetchImpl, allowLocal: true });
  assert.match(text.text, /UNAVAILABLE: 1 page\(s\) did not answer \(down\.test\)/);
  assert.match(text.text, /not re-checked \(the store did not answer\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a page shows a price in its own formats", () => {
  assert.ok(pageShowsPrice("$150.00", 150));
  assert.ok(pageShowsPrice("1 299 kr", 1299));
  assert.ok(!pageShowsPrice("$1150", 150));
  assert.ok(!pageShowsPrice("$150.50", 150));
});
