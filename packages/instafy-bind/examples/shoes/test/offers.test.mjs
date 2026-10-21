// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { buildRecords, normSize, parseProductPage, siteNameFrom } from "../handlers/lib/offers.mjs";
import * as pages from "./fixtures/pages.mjs";

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[^\s]{1,120}$/;
const RID_RE = /^[A-Za-z0-9_.:-]{1,96}$/;
const LANES = ["link", "official", "open", "capture", "feed", "assist", "local"];

function assertRecordShape(r) {
  assert.match(r.ref, REF_RE);
  assert.ok(LANES.includes(r.prov.lane));
  assert.ok(r.prov.source && r.prov.observed_at && Number.isInteger(r.prov.ttl_s));
  assert.match(r.prov.url, /^https:\/\//);
  if (r.type === "claim") {
    assert.match(r.cid, RID_RE);
    assert.match(r.attr, /^[a-z][a-z0-9_]{0,47}$/);
    if (typeof r.value === "string") assert.ok(r.value.length <= 140);
  } else if (r.type === "offer") {
    assert.match(r.oid, RID_RE);
    assert.match(r.price.currency, /^[A-Z]{3}$/);
    assert.ok(Number.isFinite(r.price.amount));
    assert.match(r.handoff.url, /^https:\/\//);
    assert.ok(["in_stock", "out", "unknown"].includes(r.availability));
  } else {
    assert.fail(`unexpected record type ${r.type}`);
  }
}

const build = (summary, extra = {}) =>
  buildRecords({ ref: "shoes:test", pageUrl: "https://shop.example/p", host: "shop.example", siteName: "Fixture Store", summary, trust: "curated", ...extra });

test("ProductGroup by colour: lowest in-stock price, colours, entity-decoded name, no sizes", () => {
  const s = parseProductPage(pages.groupByColour);
  assert.equal(s.name, "Men's Test Pulse");
  assert.equal(s.brand, "testbrand");
  assert.equal(s.low, 150, "the cheaper colour is out of stock, so it is not the headline price");
  assert.equal(s.currency, "USD");
  assert.equal(s.availability, "in_stock");
  assert.deepEqual(s.colors, ["Red", "Blue"]);
  assert.deepEqual(s.sizes, []);
  const recs = build(s, { size: "10", attr: "size_10" });
  recs.forEach(assertRecordShape);
  const size = recs.find((r) => r.attr === "size_10");
  assert.equal(size.status, "uncertain");
  assert.equal(recs.find((r) => r.attr === "sizes_listed").status, "not_found");
});

test("@graph with ListPrice → sale offer and a list_price claim", () => {
  const s = parseProductPage(pages.graphWithListPrice);
  assert.equal(s.low, 140);
  assert.equal(s.listPrice, 180);
  const recs = build(s);
  recs.forEach(assertRecordShape);
  const offer = recs.find((r) => r.type === "offer");
  assert.equal(offer.price.kind, "sale");
  assert.equal(offer.seller.trust, "curated");
  assert.equal(offer.handoff.url, "https://shop.example/p", "a handoff on another host falls back to the page URL");
  assert.equal(recs.find((r) => r.attr === "list_price").value, 180);
});

test("offers[] per size: sizes, per-size stock and size matching (M10 = 10)", () => {
  const s = parseProductPage(pages.offersPerSize);
  assert.equal(s.brand, "trailco");
  assert.equal(s.currency, "CAD");
  assert.deepEqual(s.sizes, ["M9", "M10", "M11"]);
  assert.deepEqual(s.sizeInfo.map((x) => x.in_stock), [false, true, true]);
  const hit = build(s, { size: "10", attr: "size_10" }).find((r) => r.attr === "size_10");
  assert.equal(hit.value, "In stock");
  const out = build(s, { size: "9", attr: "size_9" }).find((r) => r.attr === "size_9");
  assert.equal(out.value, "Sold out");
  const missing = build(s, { size: "14", attr: "size_14" }).find((r) => r.attr === "size_14");
  assert.equal(missing.status, "not_found");
});

test("ProductGroup varying by size (EU)", () => {
  const s = parseProductPage(pages.groupBySize);
  assert.deepEqual(s.sizes, ["42", "43", "44"]);
  assert.equal(s.currency, "EUR");
  const recs = build(s, { size: "EU 43", attr: "size_43" });
  recs.forEach(assertRecordShape);
  assert.equal(recs.find((r) => r.attr === "size_43").value, "Sold out");
  assert.equal(recs.find((r) => r.attr === "sizes_in_stock").value, "42, 44");
});

test("AggregateOffer → from price", () => {
  const s = parseProductPage(pages.aggregate);
  assert.equal(s.low, 89.99);
  assert.equal(s.high, 120);
  const offer = build(s).find((r) => r.type === "offer");
  assert.equal(offer.price.kind, "from");
  assert.equal(offer.price.currency, "GBP");
});

test("no Product data → null", () => {
  assert.equal(parseProductPage(pages.noProduct), null);
  assert.equal(parseProductPage("<html><body>hi</body></html>"), null);
});

test("helpers", () => {
  assert.equal(normSize("US 10.5"), "10.5");
  assert.equal(normSize("M8"), "8");
  assert.equal(normSize("EU 44"), "44");
  assert.equal(siteNameFrom(pages.aggregate, "x.example"), "Fixture Store");
  assert.equal(siteNameFrom("<html></html>", "x.example"), "x.example");
});
