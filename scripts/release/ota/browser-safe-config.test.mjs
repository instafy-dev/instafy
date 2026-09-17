import assert from "node:assert/strict";
import test from "node:test";

import { assertBrowserSafeConfig, assertBrowserSafeSupabaseKey } from "./browser-safe-config.mjs";

const PUBLISHABLE = "sb_publishable_Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA";

const env = (overrides = {}) => ({
  VITE_CONTROLLER_URL: "https://controller.instafy.dev",
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: PUBLISHABLE,
  VITE_OTA_CHANNEL: "internal",
  DOWNLOADS_BASE_URL: "https://downloads.instafy.dev",
  MOBILE_OTA_DOWNLOADS_PREFIX: "mobile",
  DESKTOP_DOWNLOADS_PREFIX: "desktop-app",
  ...overrides,
});

const jwt = (payload) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "c2ln"].join(".");

test("today's production configuration is publishable", () => {
  assert.deepEqual(assertBrowserSafeConfig(env()), { supabaseKey: "publishable" });
});

test("URLs must be credential-free HTTPS and the controller must be production", () => {
  assert.throws(() => assertBrowserSafeConfig(env({ VITE_CONTROLLER_URL: "" })), /is required/u);
  assert.throws(() => assertBrowserSafeConfig(env({ VITE_SUPABASE_URL: "http://project.supabase.co" })), /credential-free HTTPS/u);
  assert.throws(() => assertBrowserSafeConfig(env({ DOWNLOADS_BASE_URL: "https://user:pw@downloads.instafy.dev" })), /credential-free/u);
  assert.throws(() => assertBrowserSafeConfig(env({ VITE_CONTROLLER_URL: "https://controller.example.com" })), /production control plane/u);
});

test("service-role variables, unsafe or overlapping prefixes and other channels are refused", () => {
  const serviceRoleName = ["VITE", "SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
  assert.throws(() => assertBrowserSafeConfig(env({ [serviceRoleName]: "x" })), /forbidden in a browser build/u);
  assert.throws(() => assertBrowserSafeConfig(env({ MOBILE_OTA_DOWNLOADS_PREFIX: "../mobile" })), /safe downloads prefix/u);
  assert.throws(() => assertBrowserSafeConfig(env({ MOBILE_OTA_DOWNLOADS_PREFIX: "desktop-app/mobile" })), /overlap/u);
  assert.throws(() => assertBrowserSafeConfig(env({ VITE_OTA_CHANNEL: "stable" })), /internal OTA channel/u);
});

test("Supabase browser keys: publishable only, never secret keys", () => {
  assert.equal(assertBrowserSafeSupabaseKey(PUBLISHABLE), "publishable");
  assert.throws(() => assertBrowserSafeSupabaseKey(["sb", "secret", "abcdefghijklmnopqrstuvwxyz"].join("_")), /never be exposed/u);
  assert.throws(() => assertBrowserSafeSupabaseKey(""), /is required/u);
  assert.throws(() => assertBrowserSafeSupabaseKey(jwt({ role: "service_role" })), /role anon/u);
  assert.throws(() => assertBrowserSafeSupabaseKey(jwt({ role: "anon" })), /no longer authenticate/u);
  assert.equal(assertBrowserSafeSupabaseKey(jwt({ role: "anon" }), { allowLegacyAnonJwt: true }), "legacy-anon-jwt");
  assert.throws(() => assertBrowserSafeSupabaseKey("not-a-key"), /sb_publishable_/u);
});
