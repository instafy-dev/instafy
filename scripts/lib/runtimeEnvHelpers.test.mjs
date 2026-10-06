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
  // The provider's own folders follow the checkouts; an entry already at the
  // new place stays where it is.
  assert.ok(fs.existsSync(path.join(to, ".instafy-checkout-stamps", idle)));
  assert.ok(fs.existsSync(path.join(from, ".instafy-checkout-stamps", taken)));
  assert.ok(fs.existsSync(path.join(to, ".instafy-evicted", "gone")));
  assert.ok(!fs.existsSync(path.join(from, ".instafy-evicted")));
  // The gateway's own entries stay.
  assert.ok(fs.existsSync(path.join(from, ".git-cache", "x.git", "HEAD")));
  assert.ok(fs.existsSync(path.join(from, "Not-A-Space", "a.md")));
  assert.ok(messages.some((line) => line.includes(running)), messages.join("\n"));

  // A second start finds nothing more to move.
  const again = relocateRuntimeCheckouts({ from, to, inUse: () => false, log });
  assert.deepEqual(again.moved, [running]);
  assert.deepEqual(
    relocateRuntimeCheckouts({ from, to, inUse: () => false, log }).moved,
    []
  );
  // The same folder on both sides moves nothing.
  assert.deepEqual(relocateRuntimeCheckouts({ from: to, to, log }).moved, []);
});
