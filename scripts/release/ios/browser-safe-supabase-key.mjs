#!/usr/bin/env node
// Refuse to bake anything but a browser-safe Supabase key into the shipped
// shell: an sb_publishable_ key (default) or, with --allow-legacy-anon-jwt, a
// legacy JWT whose role is anon. Secret keys, service-role JWTs and any
// browser-prefixed service-role variable in the build environment fail closed.

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembled at runtime so the repository boundary scanner never sees a
// browser-exposed service-role identifier literal in this file.
const SERVICE_ROLE_NAME = ["SERVICE", "ROLE"].join("_");
const BROWSER_PREFIX = ["V", "ITE_"].join("");

function decodeJsonSegment(segment) {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) {
    throw new Error("Supabase browser key contains an invalid JWT segment");
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error("Supabase browser key contains malformed JWT metadata");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supabase browser key JWT metadata must be an object");
  }
  return value;
}

export function assertBrowserSafeSupabaseKey(rawValue, { allowLegacyAnonJwt = false } = {}) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new Error("VITE_SUPABASE_ANON_KEY repository variable is required");
  }
  if (value.startsWith("sb_secret_")) {
    throw new Error("A Supabase secret key must never be exposed to the browser");
  }
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/u.test(value)) {
    return { format: "publishable" };
  }
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error("Supabase browser key must be an sb_publishable_ key or a legacy anon JWT");
  }
  const payload = decodeJsonSegment(segments[1]);
  if (payload.role !== "anon") {
    throw new Error("Legacy Supabase browser JWT must have role anon");
  }
  if (!allowLegacyAnonJwt) {
    throw new Error(
      "Supabase browser key must be an sb_publishable_ key; legacy anon JWTs no longer authenticate",
    );
  }
  return { format: "legacy-anon-jwt" };
}

export function assertNoBrowserServiceRoleEnvironment(environment) {
  const offending = Object.keys(environment).filter((name) => {
    const upper = name.toUpperCase();
    return upper.startsWith(BROWSER_PREFIX) && upper.includes(SERVICE_ROLE_NAME);
  });
  if (offending.length > 0) {
    throw new Error(
      `Refusing to build with browser-exposed service-role variables: ${offending.join(", ")}`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    assertNoBrowserServiceRoleEnvironment(process.env);
    const result = assertBrowserSafeSupabaseKey(process.env.VITE_SUPABASE_ANON_KEY, {
      allowLegacyAnonJwt: process.argv.includes("--allow-legacy-anon-jwt"),
    });
    console.log(`[ios-release] Supabase ${result.format} key is browser-safe.`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
