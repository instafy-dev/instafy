#!/usr/bin/env node
// Every value validated here is compiled into a bundle that is served to every
// device, so it must be publishable: credential-free HTTPS origins, the
// production controller, safe downloads prefixes and a publishable Supabase key.

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CONTROLLER_ORIGIN = "https://controller.instafy.dev";
// Pinned to the downloads Worker contract (verify-wrangler-contract.mjs) and to what
// the private train accepts as artifact_url; a variable must not redirect signed bytes.
export const DOWNLOADS_ORIGIN = "https://downloads.instafy.dev";
export const PINNED_PREFIXES = { MOBILE_OTA_DOWNLOADS_PREFIX: "mobile", DESKTOP_DOWNLOADS_PREFIX: "desktop-app" };
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function fail(message) {
  throw new Error(message);
}

function httpsUrl(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    fail(`${name} is required for a production OTA bundle`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(`${name} must be a credential-free HTTPS URL`);
  }
  return parsed;
}

function decodeJwtPayload(segment) {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) {
    fail("Supabase browser key contains an invalid JWT segment");
  }
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {
    // fall through
  }
  return fail("Supabase browser key contains malformed JWT metadata");
}

export function assertBrowserSafeSupabaseKey(rawValue, { allowLegacyAnonJwt = false } = {}) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    fail("VITE_SUPABASE_ANON_KEY is required");
  }
  if (value.startsWith("sb_secret_")) {
    fail("A Supabase secret key must never be exposed to the browser");
  }
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/u.test(value)) {
    return "publishable";
  }
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    fail("Supabase browser key must be an sb_publishable_ key or a legacy anon JWT");
  }
  if (decodeJwtPayload(segments[1]).role !== "anon") {
    fail("Legacy Supabase browser JWT must have role anon");
  }
  if (!allowLegacyAnonJwt) {
    fail("Supabase browser key must be an sb_publishable_ key; legacy anon JWTs no longer authenticate");
  }
  return "legacy-anon-jwt";
}

export function assertBrowserSafeConfig(env, options = {}) {
  const controller = httpsUrl(env, "VITE_CONTROLLER_URL");
  if (controller.origin !== CONTROLLER_ORIGIN) {
    fail(`VITE_CONTROLLER_URL must be the production control plane ${CONTROLLER_ORIGIN}`);
  }
  httpsUrl(env, "VITE_SUPABASE_URL");
  const downloads = httpsUrl(env, "DOWNLOADS_BASE_URL");
  if (downloads.origin !== DOWNLOADS_ORIGIN || !["", "/"].includes(downloads.pathname) || downloads.search || downloads.hash) {
    fail(`DOWNLOADS_BASE_URL must be exactly ${DOWNLOADS_ORIGIN}`);
  }

  for (const name of Object.keys(env)) {
    if (/^VITE_.*SERVICE_ROLE/iu.test(name)) {
      fail(`${name} is forbidden in a browser build`);
    }
  }

  const mobile = String(env.MOBILE_OTA_DOWNLOADS_PREFIX ?? "").trim();
  const desktop = String(env.DESKTOP_DOWNLOADS_PREFIX ?? "").trim();
  for (const [name, value] of [
    ["MOBILE_OTA_DOWNLOADS_PREFIX", mobile],
    ["DESKTOP_DOWNLOADS_PREFIX", desktop],
  ]) {
    if (!value || value.split("/").some((part) => !SEGMENT.test(part))) {
      fail(`${name} is not a safe downloads prefix`);
    }
  }
  if (mobile === desktop || mobile.startsWith(`${desktop}/`) || desktop.startsWith(`${mobile}/`)) {
    fail("Desktop and mobile downloads prefixes overlap");
  }
  for (const [name, pinned] of Object.entries(PINNED_PREFIXES)) {
    if (String(env[name]).trim() !== pinned) {
      fail(`${name} must be ${pinned}`);
    }
  }

  const channel = String(env.VITE_OTA_CHANNEL ?? "");
  if (channel !== "internal") {
    fail("This lane builds only the internal OTA channel");
  }

  return { supabaseKey: assertBrowserSafeSupabaseKey(env.VITE_SUPABASE_ANON_KEY, options) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = assertBrowserSafeConfig(process.env);
    console.log(`[mobile-ota-release] Browser configuration is publishable (${result.supabaseKey} key).`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
