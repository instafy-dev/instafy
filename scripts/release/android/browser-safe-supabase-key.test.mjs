import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertBrowserSafeSupabaseKey,
  assertPublishableSupabaseKey,
  hostedCapacitorEnvironment,
} from "./browser-safe-supabase-key.mjs";

// Built at runtime so repository secret scanners never see a key-shaped literal.
const publishableKey = ["sb", "publishable", "a".repeat(32)].join("_");
const SCRIPT = path.join(import.meta.dirname, "browser-safe-supabase-key.mjs");

function jwt(payload) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "HS256", typ: "JWT" })}.${segment(payload)}.signature`;
}

const HOSTED = {
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: publishableKey,
  VITE_CONTROLLER_URL: "https://controller.instafy.dev",
};

test("classifies publishable keys and legacy anon JWTs, but releases require publishable", () => {
  assert.deepEqual(assertBrowserSafeSupabaseKey(publishableKey), { format: "publishable" });
  assert.deepEqual(assertBrowserSafeSupabaseKey(jwt({ role: "anon" })), { format: "legacy-anon-jwt" });
  assert.throws(() => assertPublishableSupabaseKey(jwt({ role: "anon" })), /must be an sb_publishable_ key/u);
});

test("rejects secret and service-role credentials without echoing them", () => {
  const secret = ["sb", "secret", "b".repeat(32)].join("_");
  assert.throws(
    () => assertBrowserSafeSupabaseKey(secret),
    (error) => /must never be exposed/u.test(error.message) && !error.message.includes(secret),
  );
  const serviceRole = jwt({ role: "service_role" });
  assert.throws(
    () => assertBrowserSafeSupabaseKey(serviceRole),
    (error) => /must have role anon/u.test(error.message) && !error.message.includes(serviceRole),
  );
  for (const value of ["", "not-a-supabase-key", "a.b", "a.%%%%.c", "sb_publishable_short"]) {
    assert.throws(() => assertBrowserSafeSupabaseKey(value));
  }
});

test("hosted environment requires credential-free HTTPS URLs and no service-role variables", () => {
  assert.equal(
    hostedCapacitorEnvironment(HOSTED),
    `VITE_SUPABASE_URL=https://project.supabase.co\nVITE_SUPABASE_ANON_KEY=${publishableKey}\nVITE_CONTROLLER_URL=https://controller.instafy.dev\n`,
  );
  for (const [override, error] of [
    [{ VITE_SUPABASE_URL: "" }, /VITE_SUPABASE_URL is required/u],
    [{ VITE_SUPABASE_URL: "http://project.supabase.co" }, /credential-free HTTPS/u],
    [{ VITE_CONTROLLER_URL: "https://user:pw@controller.instafy.dev" }, /credential-free HTTPS/u],
    [{ VITE_CONTROLLER_URL: "https://controller.instafy.dev\nVITE_X=1" }, /credential-free HTTPS|must be a URL/u],
    [{ [["VITE", "SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")]: "x" }, /must never be bundled/u],
    [{ VITE_SUPABASE_ANON_KEY: jwt({ role: "anon" }) }, /sb_publishable_/u],
  ]) {
    assert.throws(() => hostedCapacitorEnvironment({ ...HOSTED, ...override }), error);
  }
});

test("CLI seeds a private env file once and never prints values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-env-"));
  try {
    const target = path.join(root, ".env.supabase");
    const env = { PATH: process.env.PATH, ...HOSTED };
    const first = spawnSync(process.execPath, [SCRIPT, "--write-env-file", target], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr, /sb_publishable_/u);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    const second = spawnSync(process.execPath, [SCRIPT, "--write-env-file", target], { env, encoding: "utf8" });
    assert.equal(second.status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
