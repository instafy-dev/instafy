import assert from "node:assert/strict";
import test from "node:test";
import { createPerformanceReporter } from "./client.mjs";
const releaseId = "a".repeat(64);
function sample() { return { version: 1, operation: "conversation_switch", outcome: "ready", durationMs: 123,
  loadingShown: false, messageCountBucket: "201-1000", viewport: "wide" }; }
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function setup(extra = {}) {
  const timers = new Map();
  let sequence = 0;
  const calls = [];
  const reporter = createPerformanceReporter({ releaseId, random: () => 0,
    fetchImpl: async (...args) => { calls.push(args); return new Response(null, { status: 204 }); },
    setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimer: (id) => timers.delete(id), ...extra });
  return { reporter, calls, timers };
}

test("uses same-origin credential-free requests and projects only the public sample fields", async () => {
  const { reporter, calls, timers } = setup();
  reporter.record({ ...sample(), projectId: "private", content: "never send" });
  assert.equal(calls.length, 0);
  assert.equal([...timers.values()][0].delay, 5_000);
  reporter.flush(); await settle();
  const [url, options] = calls[0];
  assert.equal(url, "/__performance");
  assert.equal(options.credentials, "omit");
  assert.equal(options.referrer, "");
  assert.equal(options.referrerPolicy, "same-origin");
  assert.equal(options.mode, "same-origin");
  assert.equal(options.redirect, "error");
  assert.equal(options.keepalive, true);
  assert.deepEqual(JSON.parse(options.body), { version: 1, releaseId, samples: [sample()] });
  reporter.dispose();
  assert.equal(timers.size, 0);
});

test("deduplicates replayed sample objects and uniformly samples outcomes", async () => {
  const { reporter, calls } = setup();
  const one = sample(); reporter.record(one); reporter.record(one); reporter.flush(); await settle();
  assert.equal(JSON.parse(calls[0][1].body).samples.length, 1);
  reporter.dispose();
  const skipped = setup({ random: () => 0.5 });
  for (const outcome of ["ready", "error", "timeout", "superseded", "hidden"]) skipped.reporter.record({ ...sample(), outcome });
  skipped.reporter.flush(); await settle();
  assert.equal(skipped.calls.length, 0);
  skipped.reporter.dispose();
});

test("drops invalid sample fields before they can put free text or oversized values on the network", async () => {
  const { reporter, calls, timers } = setup();
  for (const invalid of [{ ...sample(), operation: "private text" }, { ...sample(), outcome: "private error" },
    { ...sample(), durationMs: Infinity }, { ...sample(), messageCountBucket: "x".repeat(10_000) },
    { ...sample(), viewport: "private device" }]) reporter.record(invalid);
  reporter.flush(); await settle();
  assert.equal(calls.length, 0);
  assert.equal(timers.size, 0);
  reporter.dispose();
});

test("bounds batches and total accepted samples, and does not retry failed submissions", async () => {
  const bodies = [];
  const { reporter, timers } = setup({ fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); throw new Error("offline"); } });
  for (let i = 0; i < 300; i++) { reporter.record(sample()); await settle(); }
  reporter.flush(); await settle();
  assert.equal(bodies.reduce((count, body) => count + body.samples.length, 0), 120);
  assert.ok(bodies.every((body) => body.samples.length <= 20));
  assert.equal(bodies.length, 6);
  reporter.dispose();
  assert.equal(timers.size, 0);
});

test("does not send from an unbound development build and releases an active request on dispose", async () => {
  const disabled = setup({ releaseId: "" }); disabled.reporter.record(sample()); disabled.reporter.flush(); await settle();
  assert.equal(disabled.calls.length, 0); disabled.reporter.dispose();
  let signal;
  const active = setup({ fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  active.reporter.record(sample()); active.reporter.flush(); await settle();
  assert.equal(signal.aborted, false);
  active.reporter.dispose(); await settle();
  assert.equal(signal.aborted, true);
  assert.equal(active.timers.size, 0);
});

test("leaving Studio drains a short visit once and replay does not duplicate it", async () => {
  const first = setup();
  const event = sample();
  first.reporter.record(event);
  first.reporter.finish();
  await settle();
  assert.equal(first.calls.length, 1);
  assert.equal(first.timers.size, 0);
  const revisit = setup();
  revisit.reporter.record(event); revisit.reporter.flush(); await settle();
  assert.equal(revisit.calls.length, 0);
  revisit.reporter.dispose();
});

test("finish preserves one queued batch behind an active submission without accepting new samples", async () => {
  const calls = [];
  let resolveFirst;
  const fixture = setup({ fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return new Response(null, { status: 204 });
  } });
  fixture.reporter.record(sample()); fixture.reporter.flush(); await settle();
  fixture.reporter.record(sample()); fixture.reporter.finish(); fixture.reporter.record(sample());
  resolveFirst(new Response(null, { status: 204 })); await settle();
  assert.deepEqual(calls.map((body) => body.samples.length), [1, 1]);
  assert.equal(fixture.timers.size, 0);
});
