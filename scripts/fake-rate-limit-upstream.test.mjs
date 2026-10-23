import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  createLimiter,
  normalizeRules,
  parseArgs,
  parseLimit,
  parseWindow,
  rateLimitBody,
  startFakeUpstream,
  startsConversation,
} from "./fake-rate-limit-upstream.mjs";

const body = (value) => Buffer.from(JSON.stringify(value));
const NEW = body({ model: "m", input: [{ type: "message", role: "developer", content: [] }, { type: "message", role: "user", content: [] }] });
const CONTINUING = body({
  model: "m",
  input: [
    { type: "message", role: "user", content: [] },
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ],
});
const post = (b = NEW, p = "/backend-api/codex/responses") => ({ method: "POST", path: p, body: b });

test("limits, windows and flags parse, and bad values are refused", () => {
  assert.deepEqual(parseLimit("6/20s"), { count: 6, windowMs: 20_000 });
  assert.deepEqual(parseLimit("3/1m"), { count: 3, windowMs: 60_000 });
  assert.deepEqual(parseLimit("2/500ms"), { count: 2, windowMs: 500 });
  assert.throws(() => parseLimit("0/10s"), /positive/);
  assert.throws(() => parseLimit("six"), /N\/Ws/);
  assert.deepEqual(parseWindow("60-180"), { startMs: 60_000, endMs: 180_000 });
  assert.throws(() => parseWindow("90-30"), /after/);
  assert.throws(() => normalizeRules({ failRate: 2 }), /fraction/);
  assert.throws(() => normalizeRules({ scope: "some" }), /all or new/);
  assert.throws(() => normalizeRules({ retryAfter: 0 }), /whole seconds/);
  assert.throws(() => normalizeRules({ sometimes: true }), /unknown rule/);

  const o = parseArgs(["--target", "https://chatgpt.com", "--limit", "6/20s", "--scope", "new", "--window", "0-60", "--window", "120-180"]);
  assert.equal(o.host, "127.0.0.1");
  assert.equal(o.port, 8790);
  assert.equal(o.rules.windows.length, 2);
  assert.equal(o.rules.scope, "new");
  assert.throws(() => parseArgs(["--limit", "6/20s"]), /--target is required/);
  assert.throws(() => parseArgs(["--target", "https://x.test", "--listen", "0.0.0.0:8790"]), /not a loopback/);
  assert.equal(parseArgs(["--target", "https://x.test", "--listen", "0.0.0.0:8790", "--allow-remote"]).host, "0.0.0.0");
  assert.equal(parseArgs(["--target", "https://x.test", "--listen", "[::1]:9000"]).host, "::1");
  assert.throws(() => parseArgs(["--target", "https://x.test", "--rules", "r.json", "--limit", "1/1s"]), /not both/);
  assert.throws(() => parseArgs(["--target", "file:///etc/passwd"]), /http or https/);
});

test("only a Responses body of system, developer and user messages starts a conversation", () => {
  assert.equal(startsConversation(NEW), true);
  assert.equal(startsConversation(body({ input: "hello" })), true);
  assert.equal(startsConversation(body({ input: [{ role: "user", content: "hi" }] })), true);
  assert.equal(startsConversation(CONTINUING), false);
  assert.equal(startsConversation(body({ input: [{ type: "message", role: "assistant", content: [] }] })), false);
  assert.equal(startsConversation(body({ input: [{ type: "reasoning", summary: [] }] })), false);
  assert.equal(startsConversation(body({ input: [] })), false);
  assert.equal(startsConversation(Buffer.from("not json")), false);
});

test("a limit forwards N requests per window and tells the rest when a place frees", () => {
  let t = 1_000_000;
  const limiter = createLimiter(normalizeRules({ limit: "2/20s" }), { now: () => t });
  assert.equal(limiter.decide(post()).verdict, "forwarded");
  t += 5_000;
  assert.equal(limiter.decide(post()).verdict, "forwarded");
  t += 1_000;
  assert.deepEqual(limiter.decide(post()), { verdict: "refused", reason: "limit", retryAfter: 14 });
  // A refused request takes no place: the first one leaves the window 20 s after it was forwarded.
  t += 14_000;
  assert.equal(limiter.decide(post()).verdict, "forwarded");
  assert.equal(limiter.decide(post()).verdict, "refused");
  // A GET and a path outside --path are never counted.
  assert.equal(limiter.decide({ method: "GET", path: "/backend-api/codex/responses", body: Buffer.alloc(0) }).verdict, "forwarded");
  const scoped = createLimiter(normalizeRules({ limit: "1/20s", path: "/v1/responses" }), { now: () => t });
  assert.equal(scoped.decide(post(NEW, "/v1/responses")).verdict, "forwarded");
  assert.equal(scoped.decide(post(NEW, "/v1/audio/speech")).verdict, "forwarded");
  assert.equal(scoped.decide(post(NEW, "/v1/responses")).verdict, "refused");
});

test("scope new limits only requests that start a conversation", () => {
  const limiter = createLimiter(normalizeRules({ limit: "1/30s", scope: "new" }), { now: () => 5 });
  assert.equal(limiter.decide(post(NEW)).verdict, "forwarded");
  assert.equal(limiter.decide(post(NEW)).verdict, "refused");
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.decide(post(CONTINUING)).reason, "not counted");
});

test("a fail rate refuses that fraction, only inside its windows, with the given Retry-After", () => {
  let t = 0;
  const draws = [0.1, 0.9, 0.1, 0.1];
  const limiter = createLimiter(normalizeRules({ failRate: 0.5, retryAfter: 7, windows: ["10-20"] }), { now: () => t, random: () => draws.shift() });
  assert.deepEqual(limiter.decide(post()), { verdict: "forwarded", reason: "outside window" });
  t = 10_000;
  assert.deepEqual(limiter.decide(post()), { verdict: "refused", reason: "fail-rate", retryAfter: 7 });
  assert.equal(limiter.decide(post()).verdict, "forwarded");
  assert.equal(limiter.decide(post()).verdict, "refused");
  t = 20_000;
  assert.equal(limiter.decide(post()).reason, "outside window");
  // No rules: everything is forwarded.
  const none = createLimiter(normalizeRules({}));
  for (let i = 0; i < 10; i += 1) assert.equal(none.decide(post()).verdict, "forwarded");
});

test("the refusal reads as a provider rate limit with a stated wait", () => {
  const parsed = JSON.parse(rateLimitBody(12));
  assert.equal(parsed.error.code, "rate_limit_exceeded");
  assert.match(parsed.error.message, /try again in 12s/);
  for (const plan of ["usage_limit_reached", "usage_not_included", "insufficient_quota"]) {
    assert.ok(!JSON.stringify(parsed).includes(plan), plan);
  }
});

async function startTarget() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "yes" });
      res.write("event: response.created\ndata: {}\n\n");
      setTimeout(() => res.end("event: response.completed\ndata: {}\n\n"), 20);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function send(url, pathname, payload, headers = {}) {
  const res = await fetch(`${url}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test("it forwards a streamed answer unchanged and answers over the limit itself, logging no secret", async () => {
  const target = await startTarget();
  const lines = [];
  const fake = await startFakeUpstream({ target: target.url, rules: normalizeRules({ limit: "1/30s" }), log: (line) => lines.push(JSON.stringify(line)) });
  try {
    const secret = "Bearer inert-test-credential-value";
    const first = await send(fake.url, "/backend-api/codex/responses?x=1", NEW.toString(), { authorization: secret });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-upstream"), "yes");
    assert.match(first.text, /response\.created[\s\S]*response\.completed/);
    assert.equal(target.seen.length, 1);
    assert.equal(target.seen[0].url, "/backend-api/codex/responses?x=1");
    assert.equal(target.seen[0].host, new URL(target.url).host);
    assert.equal(target.seen[0].authorization, secret);
    assert.equal(target.seen[0].body, NEW.toString());

    const second = await send(fake.url, "/backend-api/codex/responses", NEW.toString(), { authorization: secret });
    assert.equal(second.status, 429);
    assert.equal(Number(second.headers.get("retry-after")) > 0, true);
    assert.equal(JSON.parse(second.text).error.code, "rate_limit_exceeded");
    assert.equal(target.seen.length, 1, "a refused request never reaches the target");
    assert.deepEqual({ forwarded: fake.stats.forwarded, refused: fake.stats.refused }, { forwarded: 1, refused: 1 });
    const log = lines.join("\n");
    assert.ok(!log.includes("inert-test-credential-value"));
    assert.ok(!log.includes("developer"), "bodies are never logged");
    assert.match(log, /"verdict":"refused","reason":"limit"/);
  } finally {
    await fake.close();
    target.server.close();
  }
});

test("a target with a base path keeps it, and an unreachable target is a 502", async () => {
  const target = await startTarget();
  const fake = await startFakeUpstream({ target: `${target.url}/base/`, rules: normalizeRules({}) });
  try {
    assert.equal((await send(fake.url, "/v1/responses", "{}")).status, 200);
    assert.equal(target.seen[0].url, "/base/v1/responses");
  } finally {
    await fake.close();
    target.server.close();
  }
  const closed = await startFakeUpstream({ target: target.url, rules: normalizeRules({}) });
  try {
    assert.equal((await send(closed.url, "/v1/responses", "{}")).status, 502);
    assert.equal(closed.stats.upstreamErrors, 1);
  } finally {
    await closed.close();
  }
});

test("rules from a file apply when the file changes, and a broken file keeps the last good rules", async () => {
  const target = await startTarget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-429-"));
  const file = path.join(dir, "rules.json");
  const lines = [];
  const fake = await startFakeUpstream({ target: target.url, rulesFile: file, log: (line) => lines.push(line) });
  try {
    // No file yet: forward everything.
    assert.equal((await send(fake.url, "/r", NEW.toString())).status, 200);
    fs.writeFileSync(file, JSON.stringify({ failRate: 1, retryAfter: 3 }));
    const refused = await send(fake.url, "/r", NEW.toString());
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "3");
    fs.writeFileSync(file, "{ not json");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    assert.equal((await send(fake.url, "/r", NEW.toString())).status, 429);
    assert.ok(lines.some((line) => line.event === "rules file ignored"));
    fs.writeFileSync(file, JSON.stringify({}));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    assert.equal((await send(fake.url, "/r", NEW.toString())).status, 200);
  } finally {
    await fake.close();
    target.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
