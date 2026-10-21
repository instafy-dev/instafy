import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { crashLine, runScript, handlerEnv } from "../src/executors/script.mjs";
import { cleanup, eventsUrl, intentMessage, makeSite, openSse, postIntent, simpleParams, startBinder } from "./helpers.mjs";

const HANDLERS = {
  "handlers/ok.mjs": `
const kit = await import(process.env.BIND_KIT);
const input = await kit.readInput();
kit.progress(1, 2, "step one", "test-source");
kit.records([{ type: "claim", cid: "clm_1", ref: "things:a", attr: "a", value: 1, basis: "measured", prov: { source: "test-source", lane: "open", observed_at: new Date().toISOString(), ttl_s: 60 } }]);
process.stdout.write("this line is not JSON\\n");
kit.progress(2, 2, "step two");
kit.records([{ type: "claim", cid: "clm_2", ref: "things:a", attr: "b", value: 2, basis: "measured", prov: { source: "test-source", lane: "assist", observed_at: new Date().toISOString(), ttl_s: 60 } }]);
console.error("debug from handler", input.intent.name, input.site.dir === process.cwd());
kit.done("two steps");
`,
  "handlers/hang.mjs": `
process.on("SIGTERM", () => {}); // ignore SIGTERM: the binder must SIGKILL
await new Promise(() => setInterval(() => {}, 1000));
`,
  "handlers/fail.mjs": `
const kit = await import(process.env.BIND_KIT);
kit.error("not_found", "nothing there");
`,
  "handlers/crash.mjs": `
console.error("boom");
process.exit(3);
`,
  "handlers/throws.mjs": `
const kit = await import(process.env.BIND_KIT);
await kit.readInput();
async function main() { throw Object.assign(new Error("could not read www.shop.example: Header overflow"), { code: "upstream" }); }
await main();
`,
  "handlers/bare-throw.mjs": `
const fs = await import("node:fs");
fs.readFileSync({});
`,
  "handlers/env.mjs": `
const kit = await import(process.env.BIND_KIT);
kit.records([{ type: "claim", cid: "clm_env", ref: "env:x", attr: "leak", value: String(process.env.INSTAFY_ACCESS_TOKEN || "none") + "|" + String(process.env.MY_API_KEY || "none"), basis: "measured", prov: { source: "t", lane: "local", observed_at: new Date().toISOString(), ttl_s: 1 } }]);
kit.done();
`,
  "handlers/blocked.mjs": `
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
// the store answered 403: the row still ends with a reason; prov.observed_at/lane/ttl come from the kit
kit.records([kit.uncertain({ ref: "things:a", attr: "price", url: "https://shop.example/p", note: "shop.example blocks automated reads (HTTP 403)" })]);
kit.done("Store page could not be read");
`,
  "handlers/bare-prov.mjs": `
const kit = await import(process.env.BIND_KIT);
await kit.readInput();
// the handler's own fallback without prov.observed_at (the eval's shoe page): the binder stamps it
kit.records([{ type: "claim", ref: "things:a", attr: "price", cid: "clm_bare", value: null, status: "uncertain", basis: "live", confidence: "low", note: "HTTP 406", prov: { source: "hoka.com", url: "https://www.hoka.com/x" } }]);
kit.done("Store page could not be read");
`,
  "handlers/all-rejected.mjs": `
const kit = await import(process.env.BIND_KIT);
await kit.readInput();
kit.records([{ type: "claim", ref: "not a ref", attr: "price", value: 1, basis: "live" }]);
kit.done("checked");
`,
  "handlers/fetch.mjs": `
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
try { await kit.fetch(intent.params.url); kit.done("fetched"); } catch (e) { kit.error("policy", e.message); }
`,
};

function site(intents) {
  return makeSite({ ...HANDLERS, "bound.json": { version: 1, intents } });
}
const def = (handler, extra = {}) => ({ label: "X", params: simpleParams({ url: { type: "string" } }), handler, ...extra });

test("progress, records and done stream through the binder; records are applied with the lane policy", async () => {
  const dir = site({ go: def("handlers/ok.mjs") });
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const msg = intentMessage("go", { name: "a" });
    assert.equal((await postIntent(binder, msg)).status, 202);
    const done = await sse.waitFor((e) => e.event === "done" && e.data.id === msg.id);
    assert.equal(done.data.summary, "two steps");
    assert.equal(done.data.count, 1);
    assert.equal(done.data.rejected, 1, "the assist-lane record is rejected for a script intent");
    const progress = sse.events.filter((e) => e.event === "progress").map((e) => e.data.progress);
    assert.deepEqual(progress[0], { step: 1, of: 2, message: "step one", source: "test-source" });
    assert.equal(progress[1].message, "step two");
    const file = JSON.parse(fs.readFileSync(path.join(dir, "data/records/go.json"), "utf8"));
    assert.deepEqual(file.records.map((r) => r.cid), ["clm_1"]);
    assert.ok(binder.logs.some((l) => /not JSON/.test(l.text)));
    assert.ok(binder.logs.some((l) => /debug from handler go true/.test(l.text)));
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("timeout kills the handler (SIGTERM, then SIGKILL) and reports error timeout", async () => {
  const dir = site({ hang: def("handlers/hang.mjs", { timeout_s: 1 }) });
  const binder = await startBinder(dir, { killGraceMs: 200 });
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const msg = intentMessage("hang", { name: "a" });
    await postIntent(binder, msg);
    const started = Date.now();
    const error = await sse.waitFor((e) => e.event === "error" && e.data.id === msg.id, 4000);
    assert.equal(error.data.error.code, "timeout");
    assert.ok(Date.now() - started < 2500);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("cancel intent kills a running job and emits error cancelled", async () => {
  const dir = site({ hang: def("handlers/hang.mjs", { timeout_s: 30 }) });
  const binder = await startBinder(dir, { killGraceMs: 100 });
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const msg = intentMessage("hang", { name: "a" });
    const accepted = await postIntent(binder, msg);
    await sse.waitFor((e) => e.event === "ack" && e.data.status === "running");
    assert.equal((await postIntent(binder, intentMessage("cancel", { id: msg.id }))).status, 403, "another viewer has no cancel key");
    const cancel = await postIntent(binder, intentMessage("cancel", { id: msg.id, key: accepted.body.cancel_key }));
    assert.equal(cancel.status, 200);
    const error = await sse.waitFor((e) => e.event === "error" && e.data.id === msg.id);
    assert.equal(error.data.error.code, "cancelled");
    assert.equal((await postIntent(binder, intentMessage("cancel", { id: msg.id, key: accepted.body.cancel_key }))).status, 404, "nothing left to cancel");
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("handler error messages and crashes become error events", async () => {
  const dir = site({ fail: def("handlers/fail.mjs"), crash: def("handlers/crash.mjs") });
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const a = intentMessage("fail", { name: "a" });
    const b = intentMessage("crash", { name: "b" });
    await postIntent(binder, a);
    await postIntent(binder, b);
    const ea = await sse.waitFor((e) => e.event === "error" && e.data.id === a.id);
    assert.deepEqual(ea.data.error, { code: "not_found", message: "nothing there" });
    const eb = await sse.waitFor((e) => e.event === "error" && e.data.id === b.id);
    assert.equal(eb.data.error.code, "upstream");
    assert.match(eb.data.error.message, /code 3: boom/);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("handlers never see Instafy credentials; declared env names pass through; secrets need --allow-env", async () => {
  const base = { PATH: "/bin", HOME: "/owner-home", MY_API_KEY: "k", GITHUB_TOKEN: "g", STEP_MS: "5", INSTAFY_ACCESS_TOKEN: "secret", CONTROLLER_ACCESS_TOKEN: "s2" };
  const env = handlerEnv({ siteDir: "/s", intentId: "int_a_1234", allowLocal: false, extra: ["MY_API_KEY", "GITHUB_TOKEN", "STEP_MS", "INSTAFY_ACCESS_TOKEN"], env: base });
  assert.equal(env.STEP_MS, "5");
  assert.equal(env.MY_API_KEY, undefined, "credential-like names are refused by default");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.INSTAFY_ACCESS_TOKEN, undefined);
  assert.equal(env.CONTROLLER_ACCESS_TOKEN, undefined);
  assert.notEqual(env.HOME, "/owner-home", "HOME points at the binder cache, not the owner's home");
  assert.match(env.HOME, /instafy-bind/);
  assert.equal(env.BIND_SITE, "/s");
  const allowed = handlerEnv({ siteDir: "/s", intentId: "int_a_1234", allowLocal: false, extra: ["MY_API_KEY", "INSTAFY_ACCESS_TOKEN"], allowEnv: ["MY_API_KEY", "INSTAFY_ACCESS_TOKEN"], env: base });
  assert.equal(allowed.MY_API_KEY, "k");
  assert.equal(allowed.INSTAFY_ACCESS_TOKEN, undefined, "Instafy names are never passed, even when allowed");

  const dir = site({ env: def("handlers/env.mjs", { lanes: ["local"], env: ["MY_API_KEY"] }) });
  const before = { ...process.env };
  process.env.INSTAFY_ACCESS_TOKEN = "secret-token";
  process.env.MY_API_KEY = "visible";
  try {
    const records = [];
    await runScript({
      handler: path.join(dir, "handlers/env.mjs"),
      siteDir: dir,
      input: { intent: intentMessage("env", { name: "a" }), bound: {}, site: { dir } },
      onRecords: (list) => records.push(...list),
      envNames: ["MY_API_KEY"],
      allowEnv: ["MY_API_KEY"],
    });
    assert.equal(records[0].value, "none|visible");
  } finally {
    process.env = before;
    cleanup(dir);
  }
});

test("a handler that throws still answers with what went wrong, not Node's version line", async () => {
  const dir = site({ t: def("handlers/throws.mjs"), b: def("handlers/bare-throw.mjs") });
  const run = (name) => runScript({ handler: path.join(dir, `handlers/${name}.mjs`), siteDir: dir, input: { intent: intentMessage(name, { name: "a" }), bound: {}, site: { dir } } });
  try {
    // With the kit loaded: its own error message.
    await assert.rejects(run("throws"), (e) => e.code === "upstream" && e.message === "could not read www.shop.example: Header overflow");
    // Without the kit: the error line from the stack trace.
    await assert.rejects(run("bare-throw"), (e) => e.code === "upstream" && /^handler exited with code 1: TypeError \[ERR_INVALID_ARG_TYPE\]: /.test(e.message) && !/Node\.js v/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test("crashLine picks the error line out of Node's crash output", () => {
  const stderr = [
    "node:_http_client:615", "  const ret = parser.execute(d);", "                     ^", "",
    "Error: Parse Error: Header overflow", "    at TLSSocket.socketOnData (node:_http_client:615:22) {",
    "  bytesParsed: 1378,", "  code: 'HPE_HEADER_OVERFLOW',", "}", "", "Node.js v24.17.0",
  ].join("\n");
  assert.equal(crashLine(stderr), "Error: Parse Error: Header overflow");
  assert.equal(crashLine("boom\n"), "boom");
  assert.equal(crashLine("Node.js v24.17.0\n"), "");
});

test("the handler kit's fetch refuses loopback unless --allow-local", async () => {
  const dir = site({ fetch_it: def("handlers/fetch.mjs") });
  const run = (allowLocal) =>
    runScript({
      handler: path.join(dir, "handlers/fetch.mjs"),
      siteDir: dir,
      input: { intent: intentMessage("fetch_it", { name: "a", url: "http://127.0.0.1:9/" }), bound: {}, site: { dir } },
      allowLocal,
    });
  try {
    await assert.rejects(run(false), (error) => error.code === "policy" && /private or local/.test(error.message));
    await assert.rejects(run(true), (error) => error.code === "policy" && /ECONNREFUSED/.test(error.message), "with --allow-local the request is attempted");
  } finally {
    cleanup(dir);
  }
});

test("a blocked read still answers: kit.uncertain and a bare fallback are applied, with stamped provenance", async () => {
  const dir = site({ blocked: def("handlers/blocked.mjs"), bare: def("handlers/bare-prov.mjs") });
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    for (const name of ["blocked", "bare"]) {
      const msg = intentMessage(name, { name: "a" });
      assert.equal((await postIntent(binder, msg)).status, 202);
      const done = await sse.waitFor((e) => (e.event === "done" || e.event === "error") && e.data.id === msg.id);
      assert.equal(done.event, "done", JSON.stringify(done.data));
      assert.equal(done.data.count, 1, `${name}: the uncertain claim is applied`);
      assert.equal(done.data.rejected, 0);
      const record = JSON.parse(fs.readFileSync(path.join(dir, `data/records/${name}.json`), "utf8")).records[0];
      assert.equal(record.status, "uncertain");
      assert.ok(Date.parse(record.prov.observed_at) > 0, "observed_at is stamped");
      assert.equal(record.prov.lane, "local");
      assert.ok(record.prov.ttl_s > 0);
    }
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("a handler whose every record is rejected ends in an error the page can show, not a silent done", async () => {
  const dir = site({ go: def("handlers/all-rejected.mjs") });
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const msg = intentMessage("go", { name: "a" });
    assert.equal((await postIntent(binder, msg)).status, 202);
    const end = await sse.waitFor((e) => (e.event === "done" || e.event === "error") && e.data.id === msg.id);
    assert.equal(end.event, "error");
    assert.equal(end.data.error.code, "invalid");
    assert.match(end.data.error.message, /record was rejected: /);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});
