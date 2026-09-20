#!/usr/bin/env node
// Every value validated here is compiled into the hosted web bundle served to
// every browser, so it must be publishable: the production controller, a
// credential-free Supabase URL, the pinned downloads origin and prefix, a
// publishable Supabase key, and no service-role or collector override.

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CONTROLLER_ORIGIN = "https://controller.instafy.dev";
export const DOWNLOADS_ORIGIN = "https://downloads.instafy.dev";
export const DESKTOP_DOWNLOADS_PREFIX = "desktop-app";

function fail(message) {
  throw new Error(message);
}

function httpsUrl(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) fail(`${name} is required for the hosted web build`);
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

export function assertPublishableSupabaseKey(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) fail("VITE_SUPABASE_ANON_KEY is required");
  if (value.startsWith(["sb", "secret", ""].join("_"))) fail("A Supabase secret key must never be exposed to the browser");
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/u.test(value)) {
    fail("Supabase browser key must be an sb_publishable_ key; legacy anon JWTs no longer authenticate");
  }
  return "publishable";
}

export function assertBrowserSafeConfig(env) {
  if (httpsUrl(env, "VITE_CONTROLLER_URL").origin !== CONTROLLER_ORIGIN) {
    fail(`VITE_CONTROLLER_URL must be the production control plane ${CONTROLLER_ORIGIN}`);
  }
  httpsUrl(env, "VITE_SUPABASE_URL");
  const downloads = httpsUrl(env, "VITE_DOWNLOADS_BASE_URL");
  if (downloads.origin !== DOWNLOADS_ORIGIN || !["", "/"].includes(downloads.pathname) || downloads.search || downloads.hash) {
    fail(`VITE_DOWNLOADS_BASE_URL must be exactly ${DOWNLOADS_ORIGIN}`);
  }
  if (String(env.VITE_DESKTOP_DOWNLOADS_PREFIX ?? "") !== DESKTOP_DOWNLOADS_PREFIX) {
    fail(`VITE_DESKTOP_DOWNLOADS_PREFIX must be ${DESKTOP_DOWNLOADS_PREFIX}`);
  }
  for (const name of Object.keys(env)) {
    if (/^VITE_.*SERVICE_ROLE/iu.test(name)) fail(`${name} is forbidden in a browser build`);
    if (/^VITE_DEV_/u.test(name)) fail(`${name} is forbidden in a production build`);
  }
  if (env.INSTAFY_STUDIO_PERFORMANCE_COLLECTOR_ENABLED === "true") {
    fail("The Studio performance collector cannot be enabled from the hosted web lane");
  }
  return { supabaseKey: assertPublishableSupabaseKey(env.VITE_SUPABASE_ANON_KEY) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = assertBrowserSafeConfig(process.env);
    console.log(`[web-release] Browser configuration is publishable (${result.supabaseKey} key).`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
