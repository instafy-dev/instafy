import test from "node:test";
import assert from "node:assert/strict";
import { mergeRecords, normalizeRecord, rid, validateRecord, validateRecordsFile } from "../src/records.mjs";
import { claim } from "./helpers.mjs";

const at = (s) => new Date(Date.UTC(2026, 9, 11, 12, 0, s)).toISOString();

test("records schema: claim, offer and item validate; bad shapes do not", () => {
  assert.deepEqual(validateRecord(claim()), []);
  const offer = {
    type: "offer", oid: "off_a_42", ref: "products:a", price: { amount: 99.5, currency: "EUR", kind: "sale" }, availability: "in_stock",
    seller: { name: "Shop", trust: "unknown" }, handoff: { url: "https://shop.example/a" }, basis: "live",
    prov: { source: "shop.example", lane: "assist", url: "https://shop.example/a", observed_at: at(0), ttl_s: 600, class: "live" },
  };
  assert.deepEqual(validateRecord(offer), []);
  const item = { type: "item", iid: "itm_1", kind: "lodging", name: { en: "X" }, geo: { lng: 121.5, lat: 25 }, props: { rooms: 3 }, prov: claim().prov };
  assert.deepEqual(validateRecord(item), []);

  assert.match(JSON.stringify(validateRecord({ ...offer, price: { amount: -1, currency: "eur" } })), /currency|>= 0/);
  assert.ok(validateRecord({ ...offer, handoff: { url: "javascript:alert(1)" } }).length > 0, "non-https URLs are rejected");
  assert.ok(validateRecord(claim({ ref: "no-colon" })).length > 0);
  assert.ok(validateRecord(claim({ extra: 1 })).length > 0);
  assert.ok(validateRecord(claim({ prov: { lane: "made-up" } })).length > 0);
  assert.ok(validateRecord({ type: "note" }).length > 0);
  assert.deepEqual(validateRecordsFile({ schema: "instafy.records@1", records: [claim(), offer, item] }), []);
  assert.ok(validateRecordsFile({ schema: "instafy.records@2", records: [] }).length > 0);
});

test("normalizeRecord maps observer/ttl aliases", () => {
  const raw = claim({ prov: { observer: "me", ttl: 5 } });
  delete raw.prov.ttl_s;
  const out = normalizeRecord(raw);
  assert.equal(out.prov.observed_by, "me");
  assert.equal(out.prov.ttl_s, 5);
  assert.equal(out.prov.observer, undefined);
  assert.equal(out.prov.ttl, undefined);
  assert.equal(raw.prov.observer, "me", "input is not mutated");
});

test("merge: same key, newer observed_at wins; older is kept out", () => {
  const old = claim({ value: "red", prov: { observed_at: at(1) } });
  const newer = claim({ value: "blue", prov: { observed_at: at(5) } });
  const stale = claim({ value: "green", prov: { observed_at: at(0) } });
  let result = mergeRecords([old], [newer]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].value, "blue");
  assert.equal(result.replaced, 1);
  result = mergeRecords(result.records, [stale]);
  assert.equal(result.records[0].value, "blue");
  assert.equal(result.kept, 1);
});

test("merge: claims with the same (ref, attr, source) but a new cid replace the older one", () => {
  const a = claim({ cid: "clm_a", prov: { observed_at: at(1) } });
  const b = claim({ cid: "clm_b", value: "blue", prov: { observed_at: at(2) } });
  const otherSource = claim({ cid: "clm_c", prov: { source: "elsewhere", observed_at: at(3) } });
  const result = mergeRecords([a], [b, otherSource]);
  assert.deepEqual(result.records.map((r) => r.cid).sort(), ["clm_b", "clm_c"]);
  assert.equal(result.dropped, 1);
  const older = mergeRecords([b], [claim({ cid: "clm_old", prov: { observed_at: at(0) } })]);
  assert.deepEqual(older.records.map((r) => r.cid), ["clm_b"]);
});

test("merge: offers and items key by oid and iid", () => {
  const base = { ref: "p:a", price: { amount: 1, currency: "EUR" }, prov: claim().prov };
  const result = mergeRecords([{ type: "offer", oid: "o1", ...base }], [{ type: "offer", oid: "o2", ...base }, { type: "item", iid: "o1", kind: "x", name: {}, geo: { lng: 0, lat: 0 }, prov: base.prov }]);
  assert.equal(result.records.length, 3);
});

test("rid builds ids inside the rid pattern", () => {
  assert.equal(rid("clm", "Lore Hotel", "licence"), "clm_Lore_Hotel_licence");
  assert.ok(rid("x", "a".repeat(200)).length <= 96);
});
