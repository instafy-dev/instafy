import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyBatch, checkRecords, collectRecords, readVersion, writeRecords } from "../src/apply.mjs";
import { checkBound } from "../src/bound.mjs";
import { claim, cleanup, makeSite, nowIso, simpleParams } from "./helpers.mjs";

const intent = { id: "int_abc_1234", name: "check", params: { name: "x" } };
const scriptDef = { label: "Check", params: simpleParams(), handler: "handlers/x.mjs" };
const agentDef = { label: "Check", params: simpleParams(), agent: { prompt: "p", allowed_origins: ["https://*.shop.example"] } };

test("script lanes: open, official and local by default; assist is rejected", () => {
  const { accepted, rejected } = checkRecords([claim(), claim({ cid: "c2", prov: { lane: "assist" } })], { name: "check", def: scriptDef, intent, job: "job_1" });
  assert.equal(accepted.length, 1);
  assert.match(rejected[0].reason, /lane "assist" is not allowed/);
  const custom = checkRecords([claim({ prov: { lane: "open" } })], { name: "check", def: { ...scriptDef, lanes: ["local"] }, intent, job: "job_1" });
  assert.equal(custom.accepted.length, 0);
});

test("stamps prov.intent, prov.job and the binder's own observer", () => {
  const { accepted } = checkRecords([claim({ prov: { observed_by: "someone else" } })], { name: "check", def: scriptDef, intent, job: "job_9" });
  assert.deepEqual(accepted[0].prov.intent, { name: "check", params: { name: "x" }, id: "int_abc_1234" });
  assert.equal(accepted[0].prov.job, "job_9");
  assert.equal(accepted[0].prov.observed_by, "instafy-bind/script");
});

test("a viewer's position never lands in shared records: coordinate params are withheld from prov.intent", () => {
  const nearIntent = { id: "int_near_1", name: "find_stores", params: { lat: 47.6062, lon: -122.3321, ref: "stores:nearby", radius_km: 20 } };
  const { accepted } = checkRecords([claim()], { name: "find_stores", def: scriptDef, intent: nearIntent, job: "j" });
  assert.deepEqual(accepted[0].prov.intent, { name: "find_stores", params: { ref: "stores:nearby", radius_km: 20 }, id: "int_near_1", withheld: ["lat", "lon"] });
  assert.doesNotMatch(JSON.stringify(accepted[0]), /47\.60|122\.33/);
  // Nested, paired and declared forms too.
  for (const params of [{ origin: { latitude: 1.5, longitude: 2.5 } }, { at: "47.61,-122.33" }, { point: [-122.33, 47.61] }]) {
    const { accepted: [record] } = checkRecords([claim()], { name: "n", def: scriptDef, intent: { ...nearIntent, params }, job: "j" });
    assert.deepEqual(record.prov.intent.params, {}, JSON.stringify(params));
  }
  const declared = checkRecords([claim()], { name: "n", def: { ...scriptDef, private_params: ["address"] }, intent: { ...nearIntent, params: { address: "1 Main St", q: "shoes" } }, job: "j" });
  assert.deepEqual(declared.accepted[0].prov.intent, { name: "n", params: { q: "shoes" }, id: "int_near_1", withheld: ["address"] });
  const bound = { version: 1, intents: { n: { label: "Near", handler: "handlers/n.mjs", params: { type: "object" }, private_params: ["address"] } } };
  assert.deepEqual(checkBound(bound), []);
  assert.notDeepEqual(checkBound({ ...bound, intents: { n: { ...bound.intents.n, private_params: "address" } } }), []);
});

test("declared sources are enforced", () => {
  const def = { ...scriptDef, sources: ["data.gov.tw/7780"] };
  const { accepted, rejected } = checkRecords([claim({ prov: { source: "data.gov.tw/7780" } }), claim({ cid: "c2", prov: { source: "random" } })], { name: "check", def, intent, job: "j" });
  assert.equal(accepted.length, 1);
  assert.match(rejected[0].reason, /not declared/);
});

test("agent records: lane forced to the intent lane, defaults filled, allowed_origins enforced", () => {
  const records = [
    { type: "claim", cid: "c1", ref: "p:a", attr: "price", value: 10, basis: "live", prov: { url: "https://www.shop.example/a", lane: "official" } },
    { type: "claim", cid: "c2", ref: "p:a", attr: "stock", value: "in", basis: "live", prov: { url: "https://evil.example/a" } },
  ];
  const refIntent = { ...intent, params: { name: "x", ref: "p:a" } };
  const { accepted, rejected } = checkRecords(records, { name: "check", def: agentDef, intent: refIntent, job: "j" });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].prov.lane, "assist");
  assert.equal(accepted[0].prov.source, "shop.example");
  assert.equal(accepted[0].prov.ttl_s, 3600);
  assert.equal(accepted[0].prov.observed_by, "instafy-bind/agent");
  assert.match(rejected[0].reason, /allowed_origins/);
  const laneDef = { ...agentDef, agent: { ...agentDef.agent, lane: "capture" } };
  assert.equal(checkRecords([records[0]], { name: "check", def: laneDef, intent: refIntent, job: "j" }).accepted[0].prov.lane, "capture");
  const noRef = checkRecords([records[0]], { name: "check", def: agentDef, intent, job: "j" });
  assert.match(noRef.rejected[0].reason, /has no ref/, "agent records need the intent's ref to scope them");
});

test("agent records: without allowed_origins the intent's URL params set the origins", () => {
  const def = { label: "Check", params: { type: "object", properties: { url: { type: "string", format: "uri" }, ref: { type: "string" } } }, agent: { prompt: "p" } };
  const refIntent = { ...intent, params: { url: "https://shop.example/a", ref: "p:a" } };
  const offer = (url) => ({
    type: "offer", oid: `o_${url.length}`, ref: "p:a", price: { amount: 1, currency: "EUR", kind: "regular" }, seller: { name: "S", trust: "unknown" },
    handoff: { url, label: "Open" }, basis: "live", prov: { url: "https://shop.example/a" },
  });
  const { accepted, rejected } = checkRecords([offer("https://shop.example/buy"), offer("https://phish.example/checkout")], { name: "check", def, intent: refIntent, job: "j" });
  assert.equal(accepted.length, 1);
  assert.match(rejected[0].reason, /outside allowed_origins: https:\/\/phish\.example/);
});

test("merge: assist and capture records never replace a record from another lane", () => {
  const dir = makeSite({ "index.html": "x" });
  try {
    const local = claim({ cid: "clm_price", prov: { lane: "local", source: "shop", observed_at: "2026-10-01T10:00:00Z" } });
    writeRecords(dir, "data/records/x.json", [local]);
    const copy = claim({ cid: "clm_price", value: "blue", prov: { lane: "assist", source: "shop", observed_at: "2026-10-02T10:00:00Z" } });
    const sameSource = claim({ cid: "clm_other", value: "green", prov: { lane: "assist", source: "shop", observed_at: "2026-10-02T10:00:00Z" } });
    const result = writeRecords(dir, "data/records/x.json", [copy, sameSource]);
    assert.deepEqual(result.applied.map((r) => r.cid), ["clm_other"], "the copied key is kept; the other lane's claim stands beside it");
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "data/records/x.json"), "utf8")).records;
    assert.equal(stored.find((r) => r.cid === "clm_price").value, "red");
    assert.equal(stored.length, 2);
  } finally {
    cleanup(dir);
  }
});

test("records files stay under the size limit: expired records go first, then the oldest", () => {
  const dir = makeSite({ "index.html": "x" });
  try {
    const old = (i, ttl) => claim({ cid: `clm_${i}`, attr: `a${i}`, note: "n".repeat(100), prov: { observed_at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 1000).toISOString(), ttl_s: ttl } });
    const records = Array.from({ length: 30 }, (_, i) => old(i, i < 5 ? 1 : 0));
    const result = writeRecords(dir, "data/records/x.json", records, { limit: 4000 });
    assert.ok(result.trimmed > 0);
    assert.ok(result.bytes <= 4000, `${result.bytes} bytes`);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "data/records/x.json"), "utf8")).records.map((r) => r.cid);
    for (let i = 0; i < 5; i += 1) assert.ok(!kept.includes(`clm_${i}`), "expired records are dropped first");
    assert.ok(kept.includes("clm_29"), "the newest stay");
  } finally {
    cleanup(dir);
  }
});

test("observed_at in the future is clamped to now", () => {
  const future = new Date(Date.now() + 86400_000).toISOString();
  const { accepted } = checkRecords([claim({ prov: { observed_at: future } })], { name: "check", def: scriptDef, intent, job: "j" });
  assert.ok(Date.parse(accepted[0].prov.observed_at) <= Date.now());
});

test("writeRecords merges atomically and bumps data/version.json", () => {
  const dir = makeSite({ "index.html": "<p>x</p>" });
  try {
    const first = writeRecords(dir, "data/records/check.json", [claim()], { jobs: { int_a_1234: "running" } });
    assert.equal(first.total, 1);
    const second = writeRecords(dir, "data/records/check.json", [claim({ cid: "clm_b", attr: "size" })]);
    assert.equal(second.total, 2);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "data/records/check.json"), "utf8"));
    assert.equal(file.schema, "instafy.records@1");
    assert.equal(file.records.length, 2);
    const version = readVersion(dir);
    assert.equal(version.v, 2);
    assert.equal(version.files["data/records/check.json"], 2);
    assert.equal(version.jobs.int_a_1234, "running");
    assert.deepEqual(fs.readdirSync(path.join(dir, "data/records")), ["check.json"], "no temp files left");
    assert.throws(() => writeRecords(dir, "../escape.json", [claim()]), /must look like/);
  } finally {
    cleanup(dir);
  }
});

test("applyBatch writes only accepted records to the intent target; collectRecords reads them back", () => {
  const def = { ...scriptDef, target: { records: "data/records/custom.json" } };
  const dir = makeSite({ "bound.json": { version: 1, intents: { check: def } } });
  try {
    const result = applyBatch(dir, [claim(), { type: "claim" }], { name: "check", def, intent, job: "job_1" });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.file.rel, "data/records/custom.json");
    const all = collectRecords(dir, { version: 1, intents: { check: def } });
    assert.equal(all.records.length, 1);
    assert.equal(all.files["data/records/custom.json"], result.file.v);
    const none = applyBatch(dir, [{ nope: true }], { name: "check", def, intent, job: "job_2" });
    assert.equal(none.file, null);
    assert.ok(nowIso());
  } finally {
    cleanup(dir);
  }
});

test("the bound-sites cheat sheet's uncertain claim (what a blocked script read returns) is a valid record", () => {
  // A regression run's handler wrote its "could not verify" claim with a basis outside the enum, so every
  // record was rejected and the cells stayed "Not checked". The skill's example must itself pass validation.
  const sheet = fs.readFileSync(new URL("../../runtime-agent/assets/instafy/.agents/skills/instafy-bound-sites/references/cheatsheet.md", import.meta.url), "utf8");
  const start = sheet.indexOf('{ "type": "claim", "cid": "clm_on-cm2_price_on.com"');
  assert.ok(start > 0, "the cheat sheet shows an uncertain claim");
  let depth = 0, end = start;
  for (; end < sheet.length; end += 1) {
    if (sheet[end] === "{") depth += 1;
    if (sheet[end] === "}" && --depth === 0) break;
  }
  const record = JSON.parse(sheet.slice(start, end + 1));
  assert.equal(record.status, "uncertain");
  const { accepted, rejected } = checkRecords([record], { name: "check", def: { ...scriptDef, lanes: ["local"] }, intent, job: "job_1" });
  assert.deepEqual(rejected, []);
  assert.equal(accepted.length, 1);
});
