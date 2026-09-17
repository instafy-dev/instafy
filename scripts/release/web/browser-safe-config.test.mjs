import assert from "node:assert/strict";
import test from "node:test";

import { assertBrowserSafeConfig } from "./browser-safe-config.mjs";

const publishable = () => ["sb", "publishable", "A".repeat(24)].join("_");
const env = (overrides = {}) => ({
  VITE_CONTROLLER_URL: "https://controller.instafy.dev",
  VITE_SUPABASE_URL: "https://project.supabase.example",
  VITE_SUPABASE_ANON_KEY: publishable(),
  VITE_DOWNLOADS_BASE_URL: "https://downloads.instafy.dev",
  VITE_DESKTOP_DOWNLOADS_PREFIX: "desktop-app",
  ...overrides,
});

test("the production browser configuration is accepted", () => {
  assert.deepEqual(assertBrowserSafeConfig(env()), { supabaseKey: "publishable" });
});

test("every unpublishable value fails closed", () => {
  const cases = [
    [{ VITE_CONTROLLER_URL: "https://controller.example.invalid" }, /production control plane/u],
    [{ VITE_SUPABASE_URL: "http://project.supabase.example" }, /credential-free HTTPS/u],
    [{ VITE_SUPABASE_URL: "https://user:pass@project.supabase.example" }, /credential-free HTTPS/u],
    [{ VITE_DOWNLOADS_BASE_URL: "https://downloads.instafy.dev/other" }, /exactly/u],
    [{ VITE_DESKTOP_DOWNLOADS_PREFIX: "desktop" }, /desktop-app/u],
    [{ VITE_SUPABASE_ANON_KEY: ["sb", "secret", "A".repeat(24)].join("_") }, /secret key/u],
    [{ VITE_SUPABASE_ANON_KEY: "a.b.c" }, /sb_publishable_/u],
    [{ VITE_SUPABASE_ANON_KEY: "" }, /required/u],
    [{ [["VITE", "SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")]: "x" }, /forbidden/u],
    [{ VITE_DEV_LOGIN: "x" }, /forbidden/u],
    [{ INSTAFY_STUDIO_PERFORMANCE_COLLECTOR_ENABLED: "true" }, /cannot be enabled/u],
  ];
  for (const [overrides, message] of cases) {
    assert.throws(() => assertBrowserSafeConfig(env(overrides)), message, JSON.stringify(Object.keys(overrides)));
  }
});
