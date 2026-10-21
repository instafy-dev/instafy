// Prices and current models for research lanes and new shopping pages (human-flows recheck, Oct 16): a 5-lane team
// page showed no price for any shoe although two stores' product pages publish one, two lanes researched an older
// generation (Arahi 7 while the maker sells the 9), and the chat answer led with the previous Guide 18.
// `instafy web cite` now prints the price a page states in its schema.org offers and, with --family, which
// generations of a model the page names; `instafy bind try --save` stores a script intent's records the way a click
// would, so a new page opens with its prices, each with its source and age.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cite, familyGenerations, pageOffers, runWebCommand } from "../src/web.mjs";
import { tryIntent } from "../src/try.mjs";
import { cleanup, makeSite, simpleParams } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");

function fakeFetch(pages) {
  return async (url) => {
    const page = pages[url] || { status: 404, body: "" };
    return { ok: page.status < 300, status: page.status, url, headers: { "content-type": "text/html" }, text: async () => page.body };
  };
}
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const sink = () => ({ text: "", write(t) { this.text += t; } });

test("cite prints the price a product page states in its schema.org offers, and none for an empty search page", async () => {
  const product = ld({ "@context": "https://schema.org", "@type": "Product", name: "Guide 19",
    offers: { "@type": "Offer", price: "150.00", priceCurrency: "USD", availability: "https://schema.org/InStock" } });
  const group = ld({ "@graph": [{ "@type": "ProductGroup", name: "Arahi 9", hasVariant: [
    { "@type": "Product", offers: { "@type": "Offer", price: 145, priceCurrency: "USD" } },
    { "@type": "Product", offers: { "@type": "Offer", price: 145, priceCurrency: "USD" } },
    { "@type": "Product", offers: { "@type": "AggregateOffer", lowPrice: "119.95", highPrice: "145", priceCurrency: "USD" } }] }] });
  const fetchImpl = fakeFetch({
    "https://shop.test/robots.txt": { status: 404, body: "" },
    "https://shop.test/guide-19": { status: 200, body: `<title>Guide 19</title>${product}<p>Saucony Guide 19 stability shoe</p>` },
    "https://shop.test/arahi-9": { status: 200, body: `<title>Arahi 9</title>${group}<p>HOKA Arahi 9</p>` },
    "https://shop.test/search?q=guide-18": { status: 200, body: `<title>Search</title>${product}<p>No products were found for guide 18</p>` },
  });
  const one = await cite("https://shop.test/guide-19", { fetchImpl });
  assert.deepEqual(one.result.offers, [{ amount: 150, currency: "USD", availability: "InStock", name: "Guide 19" }]);
  const many = await cite("https://shop.test/arahi-9", { fetchImpl });
  assert.deepEqual(many.result.offers.map((o) => [o.amount, o.high ?? null]), [[145, null], [119.95, 145]], "duplicates collapse, a range keeps both ends");
  const empty = await cite("https://shop.test/search?q=guide-18", { fetchImpl });
  assert.equal(empty.result.offers, undefined, "an empty search page's JSON-LD is not this item's price");
  const out = sink();
  assert.equal(await runWebCommand(["cite", "https://shop.test/guide-19"], { stdout: out, stderr: out, fetchImpl }), 0);
  assert.match(out.text, /^price on the page: 150 USD, InStock \(Guide 19\) \(schema\.org offer; copy it with source_url and retrieved_at\)$/m);
  assert.match(out.text, /^retrieved_at: \d{4}-\d{2}-\d{2}/m);
  // a page without offers prints no price line
  assert.deepEqual(pageOffers("<p>$150</p>"), []);
});

test("cite --family names the generations a page lists, newest first, and skips sizes and units", async () => {
  assert.deepEqual(familyGenerations(["Saucony Guide 19 – 8mm drop", "Guide 18 (sale)", "Guide 10mm stack", "Guide-19 wide"], "Guide").map((g) => g.gen), ["19", "18"]);
  assert.deepEqual(familyGenerations(["ASICS GT-2000 13", "GT 2000 12 on sale"], "GT-2000").map((g) => g.gen), ["13", "12"]);
  assert.deepEqual(familyGenerations(["Adrenaline GTS 24", "Brooks Adrenaline GTS 25"], "Adrenaline GTS").map((g) => g.gen), ["25", "24"]);
  assert.deepEqual(familyGenerations(["Fusion 5.0", "Fusion 4.0"], "fusion").map((g) => g.gen), ["5.0", "4.0"]);
  assert.deepEqual(familyGenerations(["nothing here"], "Guide"), []);
  const fetchImpl = fakeFetch({
    "https://maker.test/robots.txt": { status: 404, body: "" },
    "https://maker.test/stability": { status: 200, body: "<title>Stability shoes</title><li>Guide 19</li><li>Guide 18 · last season</li><li>Hurricane 25</li>" },
  });
  const r = await cite("https://maker.test/stability", { family: "Guide", fetchImpl });
  assert.equal(r.result.generations.newest, "19");
  const out = sink();
  await runWebCommand(["cite", "https://maker.test/stability", "--family", "Guide"], { stdout: out, stderr: out, fetchImpl });
  assert.match(out.text, /^generations of "Guide" on this page: 19 \(newest on this page\), 18$/m);
  const none = sink();
  await runWebCommand(["cite", "https://maker.test/stability", "--family", "Kinvara"], { stdout: none, stderr: none, fetchImpl });
  assert.match(none.text, /generations of "Kinvara" on this page: none named/);
});

const priceSite = (handler) => makeSite({
  "bound.json": { version: 1, intents: { read_offer: { label: "Check price", params: simpleParams({ url: { type: "string", maxLength: 200 } }), handler: "handlers/read.mjs" } } },
  "data/items.json": [{ ref: "shoes:guide-19", store: { url: "https://shop.test/guide-19" } }],
  "handlers/read.mjs": handler,
});
const OFFER_HANDLER = `const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
kit.records([{ type: "offer", oid: kit.rid("off", intent.params.ref, "shop.test"), ref: intent.params.ref,
  price: { amount: 150, currency: "USD" }, seller: { name: "Shop" }, prov: { source: "shop.test", url: "https://shop.test/guide-19" } }]);
kit.done("read 1 offer");
`;

test("try --save stores the accepted records like a click, with provenance; a plain try writes nothing", async () => {
  const dir = priceSite(OFFER_HANDLER);
  try {
    const params = JSON.stringify({ name: "a", ref: "shoes:guide-19" });
    const plain = await tryIntent(dir, "read_offer", params);
    assert.equal(plain.exit, 0, plain.lines.join("\n"));
    assert.equal(fs.existsSync(path.join(dir, "data", "records")), false, "without --save nothing is written");
    const saved = await tryIntent(dir, "read_offer", params, { save: true });
    assert.equal(saved.exit, 0, saved.lines.join("\n"));
    assert.match(saved.lines.join("\n"), /^saved 1 record\(s\) to data\/records\/read_offer\.json \(version 1\)/m);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "data", "records", "read_offer.json"), "utf8"));
    assert.equal(file.records.length, 1);
    const [record] = file.records;
    assert.equal(record.price.amount, 150);
    assert.equal(record.prov.source, "shop.test");
    assert.ok(Date.parse(record.prov.observed_at) > Date.now() - 60_000, "the binder's clock dates it");
    assert.equal(record.prov.intent.name, "read_offer", "retry() can re-send it");
    const version = JSON.parse(fs.readFileSync(path.join(dir, "data", "version.json"), "utf8"));
    assert.equal(version.files["data/records/read_offer.json"], 1);
    // the CLI flag reaches it; a second save merges (same oid replaces, no duplicate)
    const cli = spawnSync(process.execPath, [BIN, "try", dir, "read_offer", params, "--save"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /saved 1 record\(s\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "data", "records", "read_offer.json"), "utf8")).records.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("try --save saves nothing when the try fails", async () => {
  const dir = priceSite(`const kit = await import(process.env.BIND_KIT); await kit.readInput(); kit.error("store changed its page");`);
  try {
    const r = await tryIntent(dir, "read_offer", JSON.stringify({ name: "a", ref: "shoes:guide-19" }), { save: true });
    assert.equal(r.exit, 1);
    assert.match(r.lines.join("\n"), /saved nothing: the try failed/);
    assert.equal(fs.existsSync(path.join(dir, "data", "records")), false);
  } finally {
    cleanup(dir);
  }
});

test("kit.offers gives a handler the same schema.org price cite prints, and turns a blocked page into a reason", async () => {
  const dir = priceSite(`const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
const html = '<script type="application/ld+json">{"@type":"Product","name":"Guide 19","offers":{"@type":"AggregateOffer","lowPrice":"129.95","highPrice":"150","priceCurrency":"USD"}}</script>';
const [offer] = await kit.offers(html);
let blocked = null;
try { await kit.offers({ status: 403, text: async () => "Access denied" }); } catch (err) { blocked = err; }
kit.records([
  { type: "offer", oid: kit.rid("off", intent.params.ref, "shop.test"), ref: intent.params.ref, price: { amount: offer.amount, currency: offer.currency, kind: "sale" }, prov: { source: "shop.test", url: "https://shop.test/guide-19" } },
  kit.uncertain({ ref: intent.params.ref, attr: "price_other", url: "https://other.test/x", note: blocked.code + ": " + blocked.message }),
]);
kit.done("ok");
`);
  try {
    const r = await tryIntent(dir, "read_offer", JSON.stringify({ name: "a", ref: "shoes:guide-19" }));
    assert.equal(r.exit, 0, r.lines.join("\n"));
    assert.equal(r.accepted[0].price.amount, 129.95);
    assert.match(r.accepted[1].note, /^policy: the store blocks automated reads \(blocked \(HTTP 403\)\)/);
  } finally {
    cleanup(dir);
  }
});
