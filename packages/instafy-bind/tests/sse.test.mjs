import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventHub, MAX_STREAM_MS } from "../src/sse.mjs";
import { hostMessage } from "../src/protocol.mjs";
import { cleanup, eventsUrl, intentMessage, makeSite, openSse, postIntent, simpleParams, startBinder } from "./helpers.mjs";

const HANDLER = `
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
kit.records([{ type: "claim", cid: "clm_" + intent.params.name, ref: "things:" + intent.params.name, attr: "seen", value: true, basis: "editorial", prov: { source: "t", lane: "local", observed_at: new Date().toISOString(), ttl_s: 9 } }]);
kit.done("ok");
`;

function site() {
  return makeSite({
    "index.html": "x",
    "handlers/h.mjs": HANDLER,
    "bound.json": { version: 1, intents: { mark: { label: "Mark", params: simpleParams(), handler: "handlers/h.mjs", lanes: ["local"] } } },
  });
}

test("every viewer gets every event: two clients see the same results", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  const one = openSse(eventsUrl(binder));
  const two = openSse(eventsUrl(binder));
  await Promise.all([one.opened, two.opened]);
  try {
    const hello = await one.waitFor((e) => e.event === "hello");
    assert.deepEqual(hello.data.capabilities.intents, ["mark"]);
    assert.equal(hello.id, null, "hello is per-connection and has no event id");
    const msg = intentMessage("mark", { name: "a" });
    assert.equal((await postIntent(binder, msg)).status, 202);
    const [r1, r2] = await Promise.all([
      one.waitFor((e) => e.event === "results" && e.data.id === msg.id),
      two.waitFor((e) => e.event === "results" && e.data.id === msg.id),
    ]);
    assert.deepEqual(r1.data, r2.data);
    assert.equal(r1.data.records[0].cid, "clm_a");
    assert.deepEqual(Object.keys(r1.data.files), ["data/records/mark.json"]);
    await Promise.all([one.waitFor((e) => e.event === "done"), two.waitFor((e) => e.event === "done")]);
    assert.deepEqual(one.events.map((e) => e.event), two.events.map((e) => e.event));
    assert.equal(binder.sites[0].hub.size, 2);
  } finally {
    one.close();
    two.close();
    await binder.close();
    cleanup(dir);
  }
});

test("Last-Event-ID replays missed events from the ring buffer", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    const first = openSse(eventsUrl(binder));
    await first.opened;
    const a = intentMessage("mark", { name: "a" });
    await postIntent(binder, a);
    const doneA = await first.waitFor((e) => e.event === "done" && e.data.id === a.id);
    first.close();

    const b = intentMessage("mark", { name: "b" });
    await postIntent(binder, b);
    // wait until b is done on the server side before reconnecting
    for (let i = 0; i < 100 && binder.sites[0].jobs.jobs.find((j) => j.intent.id === b.id)?.state !== "done"; i += 1) await new Promise((r) => setTimeout(r, 20));

    const replay = openSse(eventsUrl(binder), { lastEventId: doneA.id });
    await replay.opened;
    const results = await replay.waitFor((e) => e.event === "results" && e.data.id === b.id);
    assert.ok(results.id > doneA.id);
    assert.ok(!replay.events.some((e) => e.data.id === a.id), "events up to Last-Event-ID are not replayed");
    replay.close();
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("events need the viewer token", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    const sse = openSse(`${binder.url}/__bind/events`);
    await assert.rejects(sse.opened, (error) => error.status === 401);
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("EventHub keeps a bounded ring buffer", () => {
  const hub = new EventHub({ ringSize: 3, pingMs: 60_000 });
  for (let i = 0; i < 5; i += 1) hub.broadcast(hostMessage("progress", { id: `int_a_${i}000` }));
  assert.deepEqual(hub.ring.map((e) => e.id), [3, 4, 5]);
  hub.close();
});

/** Open a raw stream and resolve when the server ends it: { status, ended, ms }. */
function rawStream(url, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const request = http.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode, request });
      }
      res.resume();
      res.on("end", () => resolve({ status: 200, ended: true, ms: Date.now() - started, request }));
    });
    request.on("error", reject);
    setTimeout(() => resolve({ status: 200, ended: false, request }), timeoutMs).unref();
  });
}

test("a stream ends on its own so the viewer's access is checked again on reconnect", async () => {
  const dir = site();
  const binder = await startBinder(dir, { hubOptions: { maxStreamMs: 300 } });
  try {
    const result = await rawStream(eventsUrl(binder));
    assert.equal(result.status, 200);
    assert.equal(result.ended, true, "the binder must end a stream instead of holding it open forever");
    assert.ok(result.ms >= 250, `ended after ${result.ms} ms`);
    assert.equal(binder.sites[0].hub.size, 0);
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("the default stream lifetime is bounded", () => {
  assert.ok(MAX_STREAM_MS > 0 && MAX_STREAM_MS <= 120_000);
  const hub = new EventHub();
  assert.equal(hub.maxStreamMs, MAX_STREAM_MS);
  hub.close();
});

test("one source behind the tunnel cannot take every stream slot", async () => {
  const dir = site();
  const binder = await startBinder(dir, { hubOptions: { maxPerSource: 2, maxStreamMs: 0 } });
  const open = [];
  try {
    const from = (ip) => ({ "x-forwarded-for": ip });
    const pending = (ip) => new Promise((resolve, reject) => {
      const request = http.get(eventsUrl(binder), { headers: from(ip) }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      request.on("error", reject);
      open.push(request);
    });
    assert.equal(await pending("203.0.113.5"), 200);
    assert.equal(await pending("203.0.113.5"), 200);
    assert.equal(await pending("203.0.113.5"), 503, "a third stream from the same source is refused");
    assert.equal(await pending("198.51.100.7"), 200, "another viewer still gets a stream");
    // This machine itself (no forwarding proxy) is not limited per source.
    for (let i = 0; i < 3; i += 1) assert.equal(await pending(""), 200);
  } finally {
    for (const request of open) request.destroy();
    await binder.close();
    cleanup(dir);
  }
});
