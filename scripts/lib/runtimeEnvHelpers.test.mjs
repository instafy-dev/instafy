import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SERVICE_RUNTIME_EMAIL,
  deleteEnvFileValue,
  ensureServiceRuntimeUserId,
  relocateRuntimeCheckouts,
  resolveRuntimeCheckoutRoot,
  setEnvFileValue,
} from "./runtimeEnvHelpers.mjs";

const captureFetch = () => {
  const originalFetch = global.fetch;
  return {
    restore() {
      global.fetch = originalFetch;
    },
  };
};

test("setEnvFileValue writes or updates a private file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-env-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, "env");
  setEnvFileValue(envPath, "FOO", "bar");
  let content = fs.readFileSync(envPath, "utf-8");
  assert.match(content, /FOO=bar/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  }
  setEnvFileValue(envPath, "FOO", "baz");
  content = fs.readFileSync(envPath, "utf-8");
  const matches = content
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FOO="));
  assert.equal(matches.length, 1);
  assert.equal(matches[0], "FOO=baz");
});

test("deleteEnvFileValue removes a stale key without changing neighboring values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-env-test-"));
  const envPath = path.join(dir, "env");
  fs.writeFileSync(
    envPath,
    "KEEP=before\nORIGIN_GIT_REMOTE_URL=http://git-edge/repo.git\nKEEP_AFTER=after\n",
    "utf-8"
  );

  deleteEnvFileValue(envPath, "ORIGIN_GIT_REMOTE_URL");

  assert.equal(fs.readFileSync(envPath, "utf-8"), "KEEP=before\nKEEP_AFTER=after\n");
});

test("ensureServiceRuntimeUserId returns existing user without creating", async (t) => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  const fetchCalls = [];
  const { restore } = captureFetch();
  t.after(() => {
    restore();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SERVICE_RUNTIME_USER_EMAIL;
  });
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, method: options.method || "GET" });
    return new Response(
      JSON.stringify({ users: [{ id: "user-123", email: DEFAULT_SERVICE_RUNTIME_EMAIL }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const result = await ensureServiceRuntimeUserId({ SUPABASE_URL: "http://supabase.local" });
  assert.deepEqual(result, {
    id: "user-123",
    email: DEFAULT_SERVICE_RUNTIME_EMAIL,
  });
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /auth\/v1\/admin\/users\?email=/);
});

test("ensureServiceRuntimeUserId creates user when none exists", async (t) => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  const fetchCalls = [];
  const { restore } = captureFetch();
  t.after(() => {
    restore();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SERVICE_RUNTIME_USER_EMAIL;
  });
  let callCount = 0;
  global.fetch = async (url, options = {}) => {
    callCount += 1;
    fetchCalls.push({ url, method: options.method || "GET" });
    if (callCount === 1) {
      return new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.email, DEFAULT_SERVICE_RUNTIME_EMAIL);
    return new Response(JSON.stringify({ id: "created-456", email: body.email }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await ensureServiceRuntimeUserId({ SUPABASE_URL: "http://supabase.local" });
  assert.deepEqual(result, {
    id: "created-456",
    email: DEFAULT_SERVICE_RUNTIME_EMAIL,
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].method, "POST");
});

test("ensureServiceRuntimeUserId returns null when service role key missing", async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const result = await ensureServiceRuntimeUserId({ SUPABASE_URL: "http://supabase.local" });
  assert.equal(result, null);
});

test("resolveRuntimeCheckoutRoot gives git-canonical runtimes a folder of their own", () => {
  const repoRoot = path.join(os.tmpdir(), "repo");
  const sandboxDir = path.join(repoRoot, "tmp", "runtime-sandbox");
  const gatewayRoot = path.join(repoRoot, "tmp", "origin-gateway-workspaces");
  const own = path.join(repoRoot, "tmp", "runtime-checkouts");
  const resolve = (env) => resolveRuntimeCheckoutRoot({ env, repoRoot, sandboxDir });

  assert.equal(resolve({ GIT_CANONICAL: "1" }), own);
  assert.notEqual(resolve({ GIT_CANONICAL: "1" }), gatewayRoot);
  // RUNTIME_REPO_HOST is the compose stack's folder, never the provider's
  // under git-canonical; without git-canonical it still applies.
  assert.equal(resolve({ GIT_CANONICAL: "1", RUNTIME_REPO_HOST: "/elsewhere" }), own);
  assert.equal(resolve({ GIT_CANONICAL: "0", RUNTIME_REPO_HOST: " /elsewhere " }), "/elsewhere");
  assert.equal(resolve({}), sandboxDir);
  // An explicit DOCKER_REPO_HOST always wins.
  assert.equal(resolve({ GIT_CANONICAL: "1", DOCKER_REPO_HOST: "/mine" }), "/mine");
});

test("relocateRuntimeCheckouts moves runtime checkouts out of the gateway's folder once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-checkouts-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, "origin-gateway-workspaces");
  const to = path.join(dir, "runtime-checkouts");
  const idle = "11111111-1111-4111-8111-111111111111";
  const running = "22222222-2222-4222-8222-222222222222";
  const taken = "33333333-3333-4333-8333-333333333333";
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(from, idle, ".instafy", ".git", "refs", "instafy", "local-recovery", "w"), "x\n");
  write(path.join(from, idle, ".env"), "LOCAL=1\n");
  write(path.join(from, running, "notes.md"), "busy\n");
  write(path.join(from, taken, "a.md"), "old\n");
  write(path.join(to, taken, "a.md"), "new\n");
  write(path.join(from, ".instafy-checkout-stamps", idle), "");
  write(path.join(from, ".instafy-checkout-stamps", running), "");
  write(path.join(from, ".instafy-checkout-stamps", taken), "");
  write(path.join(to, ".instafy-checkout-stamps", taken), "");
  fs.mkdirSync(path.join(from, ".instafy-evicted", "gone"), { recursive: true });
  write(path.join(from, ".git-cache", "x.git", "HEAD"), "ref: refs/heads/main\n");
  write(path.join(from, "Not-A-Space", "a.md"), "kept\n");
  const messages = [];
  const log = { log: (line) => messages.push(line), warn: (line) => messages.push(line) };

  const report = relocateRuntimeCheckouts({
    from,
    to,
    inUse: (id) => id === running,
    log,
  });

  assert.deepEqual(report.moved, [idle]);
  assert.deepEqual(report.kept.map((item) => item.name).sort(), [
    path.join(".instafy-checkout-stamps", running),
    path.join(".instafy-checkout-stamps", taken),
    running,
    taken,
  ]);
  assert.equal(
    fs.readFileSync(path.join(to, idle, ".instafy", ".git", "refs", "instafy", "local-recovery", "w"), "utf8"),
    "x\n"
  );
  assert.equal(fs.readFileSync(path.join(to, idle, ".env"), "utf8"), "LOCAL=1\n");
  assert.ok(!fs.existsSync(path.join(from, idle)));
  assert.equal(fs.readFileSync(path.join(from, running, "notes.md"), "utf8"), "busy\n");
  assert.equal(fs.readFileSync(path.join(to, taken, "a.md"), "utf8"), "new\n");
  assert.equal(fs.readFileSync(path.join(from, taken, "a.md"), "utf8"), "old\n");
  // A stamp follows its checkout. The stamp of a checkout that stayed stays
  // with it, and so do the provider's folders: they are what makes the
  // gateway refuse to start on this folder instead of moving that checkout
  // into its .legacy/ (park_legacy_checkouts).
  assert.ok(fs.existsSync(path.join(to, ".instafy-checkout-stamps", idle)));
  assert.ok(!fs.existsSync(path.join(from, ".instafy-checkout-stamps", idle)));
  assert.ok(fs.existsSync(path.join(from, ".instafy-checkout-stamps", running)));
  assert.ok(!fs.existsSync(path.join(to, ".instafy-checkout-stamps", running)));
  assert.ok(fs.existsSync(path.join(from, ".instafy-checkout-stamps", taken)));
  assert.ok(fs.existsSync(path.join(to, ".instafy-evicted", "gone")));
  assert.deepEqual(fs.readdirSync(path.join(from, ".instafy-evicted")), []);
  // The gateway's own entries stay.
  assert.ok(fs.existsSync(path.join(from, ".git-cache", "x.git", "HEAD")));
  assert.ok(fs.existsSync(path.join(from, "Not-A-Space", "a.md")));
  assert.ok(messages.some((line) => line.includes(running)), messages.join("\n"));

  // A second start finds nothing more to move.
  const again = relocateRuntimeCheckouts({ from, to, inUse: () => false, log });
  assert.deepEqual(again.moved, [running]);
  assert.ok(fs.existsSync(path.join(to, ".instafy-checkout-stamps", running)));
  assert.ok(!fs.existsSync(path.join(from, ".instafy-checkout-stamps", running)));
  assert.ok(fs.existsSync(path.join(from, ".instafy-checkout-stamps", taken)));
  assert.deepEqual(
    relocateRuntimeCheckouts({ from, to, inUse: () => false, log }).moved,
    []
  );
  // The same folder on both sides moves nothing.
  assert.deepEqual(relocateRuntimeCheckouts({ from: to, to, log }).moved, []);
});

test("relocateRuntimeCheckouts keeps the gateway refusing while a runtime checkout stays in its folder", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-checkouts-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, "origin-gateway-workspaces");
  const to = path.join(dir, "runtime-checkouts");
  const busy = "44444444-4444-4444-8444-444444444444";
  const idle = "55555555-5555-4555-8555-555555555555";
  const gone = "66666666-6666-4666-8666-666666666666";
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // The busy space has no stamp of its own here; the idle one has.
  write(path.join(from, busy, "draft.md"), "unsaved work\n");
  write(path.join(from, idle, "a.md"), "idle\n");
  write(path.join(from, ".instafy-checkout-stamps", idle), "");
  fs.mkdirSync(path.join(from, ".instafy-evicted", `${gone}-1`), { recursive: true });
  const messages = [];
  const log = { log: (line) => messages.push(line), warn: (line) => messages.push(line) };

  const first = relocateRuntimeCheckouts({ from, to, inUse: (id) => id === busy, log });

  assert.deepEqual(first.moved, [idle]);
  assert.ok(fs.existsSync(path.join(to, ".instafy-checkout-stamps", idle)));
  assert.ok(fs.existsSync(path.join(to, ".instafy-evicted", `${gone}-1`)));
  // Emptied, but still there while the busy checkout is.
  assert.deepEqual(fs.readdirSync(path.join(from, ".instafy-checkout-stamps")), []);
  assert.deepEqual(fs.readdirSync(path.join(from, ".instafy-evicted")), []);
  assert.equal(fs.readFileSync(path.join(from, busy, "draft.md"), "utf8"), "unsaved work\n");
  assert.ok(
    messages.some((line) => line.includes(".instafy-checkout-stamps") && line.includes("refuses to start")),
    messages.join("\n")
  );

  // Without a list of containers, nothing of the provider's moves, not even
  // the stamp of a space with no checkout left here.
  write(path.join(from, ".instafy-checkout-stamps", gone), "");
  const unknown = relocateRuntimeCheckouts({ from, to, inUse: null, log });
  assert.deepEqual(unknown.moved, []);
  assert.deepEqual(unknown.kept.map((item) => item.name), [busy]);
  assert.match(unknown.kept[0].reason, /could not be listed/);
  assert.ok(fs.existsSync(path.join(from, ".instafy-checkout-stamps", gone)));
  assert.ok(!fs.existsSync(path.join(to, ".instafy-checkout-stamps", gone)));
  assert.ok(fs.existsSync(path.join(from, ".instafy-evicted")));

  // Once nothing stays, the provider's folders follow the checkouts.
  const last = relocateRuntimeCheckouts({ from, to, inUse: () => false, log });
  assert.deepEqual(last.moved, [busy]);
  assert.deepEqual(last.kept, []);
  assert.ok(fs.existsSync(path.join(to, ".instafy-checkout-stamps", gone)));
  assert.equal(fs.readFileSync(path.join(to, busy, "draft.md"), "utf8"), "unsaved work\n");
  assert.deepEqual(fs.readdirSync(from), []);
});

test("relocateRuntimeCheckouts makes the stamp folder for a checkout that stays without one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-checkouts-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, "origin-gateway-workspaces");
  const to = path.join(dir, "runtime-checkouts");
  const busy = "77777777-7777-4777-8777-777777777777";
  fs.mkdirSync(path.join(from, busy), { recursive: true });
  fs.writeFileSync(path.join(from, busy, "draft.md"), "unsaved work\n");
  const log = { log: () => {}, warn: () => {} };

  const report = relocateRuntimeCheckouts({ from, to, inUse: () => true, log });

  assert.deepEqual(report.moved, []);
  assert.deepEqual(fs.readdirSync(from).sort(), [".instafy-checkout-stamps", busy]);
  assert.deepEqual(fs.readdirSync(path.join(from, ".instafy-checkout-stamps")), []);

  // It goes once the checkout has moved.
  assert.deepEqual(relocateRuntimeCheckouts({ from, to, inUse: () => false, log }).moved, [busy]);
  assert.deepEqual(fs.readdirSync(from), []);
});

test("relocateRuntimeCheckouts moves nothing from under a provider that is already running", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-checkouts-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, "origin-gateway-workspaces");
  const to = path.join(dir, "runtime-checkouts");
  const idle = "88888888-8888-4888-8888-888888888888";
  const busy = "99999999-9999-4999-8999-999999999999";
  const gone = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // A provider started before runtime checkouts had a folder of their own
  // keeps them in the gateway's folder, without stamps.
  write(path.join(from, idle, "a.md"), "idle\n");
  write(path.join(from, busy, "draft.md"), "unsaved work\n");
  fs.mkdirSync(path.join(from, ".instafy-evicted", `${gone}-1`), { recursive: true });
  const messages = [];
  const log = { log: (line) => messages.push(line), warn: (line) => messages.push(line) };

  // Reusing it: no container stands in the way of either space, and still
  // nothing moves.
  const reused = relocateRuntimeCheckouts({
    from,
    to,
    inUse: () => false,
    providerRunning: true,
    log,
  });

  assert.deepEqual(reused.moved, []);
  assert.deepEqual(reused.kept.map((item) => item.name), [busy, idle].sort());
  assert.ok(!fs.existsSync(to));
  assert.equal(fs.readFileSync(path.join(from, idle, "a.md"), "utf8"), "idle\n");
  assert.equal(fs.readFileSync(path.join(from, busy, "draft.md"), "utf8"), "unsaved work\n");
  assert.ok(fs.existsSync(path.join(from, ".instafy-evicted", `${gone}-1`)));
  // The stamp folder keeps the gateway from moving them into its .legacy/.
  assert.deepEqual(fs.readdirSync(path.join(from, ".instafy-checkout-stamps")), []);
  assert.ok(
    messages.some(
      (line) => line.includes("already running") && line.includes("Stop the provider") && line.includes(to)
    ),
    messages.join("\n")
  );

  // The next start, with the provider stopped, moves them.
  const started = relocateRuntimeCheckouts({ from, to, inUse: () => false, log });
  assert.deepEqual(started.moved, [busy, idle].sort());
  assert.equal(fs.readFileSync(path.join(to, busy, "draft.md"), "utf8"), "unsaved work\n");
  assert.ok(fs.existsSync(path.join(to, ".instafy-evicted", `${gone}-1`)));
  assert.deepEqual(fs.readdirSync(from), []);
});
