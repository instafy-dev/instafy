import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SERVICE_RUNTIME_EMAIL,
  deleteEnvFileValue,
  ensureServiceRuntimeUserId,
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
