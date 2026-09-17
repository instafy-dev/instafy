import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { assertBrowserSafeSupabaseKey, assertNoBrowserServiceRoleEnvironment } from "./browser-safe-supabase-key.mjs";

const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload) => [segment({ alg: "HS256", typ: "JWT" }), segment(payload), "signature"].join(".");
const publishable = ["sb", "publishable", "Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"].join("_");
const secret = ["sb", "secret", "Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"].join("_");
const serviceRoleVariable = ["V", "ITE_SUPABASE_", "SERVICE", "_ROLE_KEY"].join("");

test("accepts only publishable keys by default", () => {
  assert.deepEqual(assertBrowserSafeSupabaseKey(publishable), { format: "publishable" });
  assert.throws(() => assertBrowserSafeSupabaseKey(""), /is required/u);
  assert.throws(() => assertBrowserSafeSupabaseKey(secret), /secret key must never/u);
  assert.throws(() => assertBrowserSafeSupabaseKey(jwt({ role: "anon" })), /must be an sb_publishable_ key/u);
  assert.throws(() => assertBrowserSafeSupabaseKey("random"), /publishable_ key or a legacy anon JWT/u);
});

test("legacy anon JWTs need an explicit opt-in and service-role JWTs never pass", () => {
  assert.deepEqual(assertBrowserSafeSupabaseKey(jwt({ role: "anon" }), { allowLegacyAnonJwt: true }), { format: "legacy-anon-jwt" });
  assert.throws(() => assertBrowserSafeSupabaseKey(jwt({ role: "service_role" }), { allowLegacyAnonJwt: true }), /role anon/u);
  assert.throws(() => assertBrowserSafeSupabaseKey("a.%%%.c", { allowLegacyAnonJwt: true }), /invalid JWT segment/u);
});

test("refuses browser-prefixed service-role variables in the build environment", () => {
  assert.doesNotThrow(() => assertNoBrowserServiceRoleEnvironment({ VITE_SUPABASE_URL: "x" }));
  assert.throws(() => assertNoBrowserServiceRoleEnvironment({ [serviceRoleVariable]: "x" }), /service-role variables/u);
});

test("CLI fails closed without echoing the key", () => {
  const script = new URL("./browser-safe-supabase-key.mjs", import.meta.url).pathname;
  const ok = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, VITE_SUPABASE_ANON_KEY: publishable }, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.stdout + ok.stderr, /Q7mX2vK9/u);
  const bad = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, VITE_SUPABASE_ANON_KEY: secret }, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stdout + bad.stderr, /Q7mX2vK9/u);
});
