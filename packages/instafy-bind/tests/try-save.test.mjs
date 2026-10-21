// `instafy-bind try --save` stores a script intent's records the way a click would, so a new page opens with its
// values, each with its source and age; kit.offers reads the prices a page states in its schema.org offers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pageOffers } from "../src/web.mjs";
import { tryIntent } from "../src/try.mjs";
import { cleanup, makeSite, simpleParams } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

test("pageOffers reads schema.org offers: duplicates collapse, a range keeps both ends, no offers no price", () => {
  const product = ld({ "@context": "https://schema.org", "@type": "Product", name: "Guide 19",
    offers: { "@type": "Offer", price: "150.00", priceCurrency: "USD", availability: "https://schema.org/InStock" } });
  assert.deepEqual(pageOffers(`<title>Guide 19</title>${product}`), [{ amount: 150, currency: "USD", availability: "InStock", name: "Guide 19" }]);
  const group = ld({ "@graph": [{ "@type": "ProductGroup", name: "Arahi 9", hasVariant: [
    { "@type": "Product", offers: { "@type": "Offer", price: 145, priceCurrency: "USD" } },
    { "@type": "Product", offers: { "@type": "Offer", price: 145, priceCurrency: "USD" } },
    { "@type": "Product", offers: { "@type": "AggregateOffer", lowPrice: "119.95", highPrice: "145", priceCurrency: "USD" } }] }] });
  assert.deepEqual(pageOffers(group).map((o) => [o.amount, o.high ?? null]), [[145, null], [119.95, 145]]);
  assert.deepEqual(pageOffers("<p>$150</p>"), []);
  // unquoted type, upper case tags, and a long run of unclosed script tags stays linear
  assert.equal(pageOffers(`<SCRIPT type=application/ld+json>{"@type":"Offer","price":9,"priceCurrency":"EUR"}</SCRIPT>`)[0].amount, 9);
  const started = Date.now();
  assert.deepEqual(pageOffers("<script type=application/ld+json>".repeat(20000)), []);
  assert.ok(Date.now() - started < 1000, "no backtracking on hostile markup");
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

test("kit.offers gives a handler the schema.org price, and turns a blocked page into a reason", async () => {
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
