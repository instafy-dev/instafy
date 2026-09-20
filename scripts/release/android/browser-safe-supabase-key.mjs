#!/usr/bin/env node
// Validates the browser-visible values baked into the Android binary and, with
// --write-env-file <path>, seeds the .env.supabase that
// scripts/set-capacitor-frontend-env.mjs reads. Values are never printed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

export function assertBrowserSafeSupabaseKey(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) throw new Error("VITE_SUPABASE_ANON_KEY repository variable is required");
  if (value.startsWith("sb_secret_")) {
    throw new Error("A Supabase secret key must never be exposed to the browser");
  }
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/u.test(value)) return { format: "publishable" };
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error("Supabase browser key must be an sb_publishable_ key or a legacy anon JWT");
  }
  if (decodeJsonSegment(segments[1]).role !== "anon") {
    throw new Error("Legacy Supabase browser JWT must have role anon");
  }
  return { format: "legacy-anon-jwt" };
}

export function assertPublishableSupabaseKey(rawValue) {
  const result = assertBrowserSafeSupabaseKey(rawValue);
  if (result.format !== "publishable") {
    throw new Error(
      "Supabase browser key must be an sb_publishable_ key; the legacy anon JWT class is disabled and cannot authenticate",
    );
  }
  return result;
}

function credentialFreeHttpsUrl(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required for a hosted Android release`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || /[\s\r\n]/u.test(value)) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return value;
}

export function hostedCapacitorEnvironment(env) {
  for (const name of Object.keys(env)) {
    if (/^VITE_.*SERVICE_ROLE/u.test(name)) {
      throw new Error(`${name} must never be bundled into a mobile binary`);
    }
  }
  const supabaseUrl = credentialFreeHttpsUrl(env, "VITE_SUPABASE_URL");
  const controllerUrl = credentialFreeHttpsUrl(env, "VITE_CONTROLLER_URL");
  assertPublishableSupabaseKey(env.VITE_SUPABASE_ANON_KEY);
  return [
    `VITE_SUPABASE_URL=${supabaseUrl}`,
    `VITE_SUPABASE_ANON_KEY=${String(env.VITE_SUPABASE_ANON_KEY).trim()}`,
    `VITE_CONTROLLER_URL=${controllerUrl}`,
    "",
  ].join("\n");
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.log(`[android-release] Supabase ${assertPublishableSupabaseKey(process.env.VITE_SUPABASE_ANON_KEY).format} key is browser-safe.`);
    } else if (args.length === 2 && args[0] === "--write-env-file") {
      const contents = hostedCapacitorEnvironment(process.env);
      fs.writeFileSync(args[1], contents, { mode: 0o600, flag: "wx" });
      fs.chmodSync(args[1], 0o600);
      console.log("[android-release] Hosted Capacitor environment is browser-safe and seeded.");
    } else {
      throw new Error("usage: browser-safe-supabase-key.mjs [--write-env-file <path>]");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
