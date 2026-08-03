#!/usr/bin/env node
/**
 * Mint a throwaway Supabase user and print a browser-injectable session.
 *
 * Purpose: an automated agent needs to reach the authenticated Studio without a
 * human clicking through the login wall. This creates a confirmed user with the
 * GoTrue admin API, signs it in, and prints the session together with the exact
 * localStorage key/value that `packages/frontend/src/lib/supabaseClient.ts`
 * reads, so the session can be injected into a browser before the app boots.
 *
 * SAFETY (this tool can create users and mint sessions):
 *   - The default target is the LOCAL Supabase stack, and configuration for it
 *     is read from `supabase status`, NOT from process.env. That matters on
 *     developer machines: `${INSTAFY_ENV_DIR:-~/.config/instafy/env}/.env.supabase`
 *     holds hosted-project credentials, and any shell that has sourced it would
 *     otherwise hand this script a self-consistent production URL + admin key.
 *   - The run is refused when the resolved URL is not localhost, or when the
 *     resolved admin key carries hosted-project claims (`iss: "supabase"` or a
 *     `ref` claim), unless the caller opted in to a remote target.
 *   - A remote target needs BOTH `--target remote` AND
 *     `INSTAFY_MINT_TEST_USER_ALLOW_REMOTE=<project-ref>` matching the resolved
 *     URL. Bulk cleanup is never allowed against a remote target.
 *   - The service-role key is never printed. Printed sessions are short-lived
 *     user tokens for a throwaway user, which is the point.
 *
 * Preconditions: `pnpm supabase:up` for the local stack.
 *
 * Usage: node scripts/mint-test-user.mjs --help
 */

import process from "node:process";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseAnonKey,
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "./lib/localSupabaseEnv.mjs";

const __filename = fileURLToPath(import.meta.url);

export const REMOTE_OPT_IN_VARIABLE = "INSTAFY_MINT_TEST_USER_ALLOW_REMOTE";
export const TEST_EMAIL_PREFIX = "agent-test-";
export const TEST_EMAIL_DOMAIN = "instafy.local";
export const TEST_USER_MARKER = "instafy_mint_test_user";
export const TEST_ORG_SLUG_PREFIX = "agent-test-";
export const DEFAULT_ORG_ROLE = "owner";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const HOSTED_ISSUER = "supabase";
const REQUEST_TIMEOUT_MS = 20_000;
const EMPTY_ENV = Object.freeze({});

export class MintError extends Error {
  constructor(message, { code = "mint_failed", hint = "" } = {}) {
    super(message);
    this.name = "MintError";
    this.code = code;
    this.hint = hint;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                           */
/* -------------------------------------------------------------------------- */

export function trimSlash(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

/**
 * Mirrors `validateSupabaseUrl` in @supabase/supabase-js so the URL this script
 * reasons about is the same URL the browser client would build.
 */
export function parseSupabaseUrl(supabaseUrl) {
  const trimmed = String(supabaseUrl ?? "").trim();
  if (!trimmed) {
    throw new MintError("Could not resolve a Supabase URL.", {
      code: "missing_supabase_url",
      hint: "Start the local stack with `pnpm supabase:up`.",
    });
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new MintError(`Invalid Supabase URL (needs http:// or https://): ${trimmed}`, {
      code: "invalid_supabase_url",
    });
  }
  try {
    return new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  } catch {
    throw new MintError(`Malformed Supabase URL: ${trimmed}`, {
      code: "invalid_supabase_url",
    });
  }
}

/**
 * The frontend calls `createClient(url, anonKey, { auth: { persistSession: true } })`
 * without a `storageKey`, so supabase-js derives one. Verified against the
 * installed @supabase/supabase-js 2.75.0 (SupabaseClient.js):
 *
 *   const defaultStorageKey = `sb-${baseUrl.hostname.split('.')[0]}-auth-token`
 *
 * Note this is the first hostname label, NOT the project ref: a local stack on
 * http://127.0.0.1:54321 yields `sb-127-auth-token`.
 */
export function deriveStorageKey(supabaseUrl) {
  const url = parseSupabaseUrl(supabaseUrl);
  return `sb-${url.hostname.split(".")[0]}-auth-token`;
}

export function decodeJwtClaims(token) {
  const value = String(token ?? "").trim();
  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

export function classifySupabaseTarget({ supabaseUrl, serviceRoleKey } = {}) {
  const url = parseSupabaseUrl(supabaseUrl);
  const hostname = url.hostname.toLowerCase();
  const claims = decodeJwtClaims(serviceRoleKey);
  const issuer = typeof claims?.iss === "string" ? claims.iss : "";
  const keyProjectRef = typeof claims?.ref === "string" ? claims.ref : "";
  return {
    url,
    origin: trimSlash(url.toString()),
    hostname,
    isLocalHostname: LOCAL_HOSTNAMES.has(hostname),
    // Same rule supabase-js uses for the storage key namespace.
    projectRef: hostname.split(".")[0],
    issuer,
    keyProjectRef,
    keyRole: typeof claims?.role === "string" ? claims.role : "",
    // Hallmarks of a hosted Supabase project's API key.
    looksHosted: issuer === HOSTED_ISSUER || keyProjectRef !== "",
  };
}

/**
 * Refuses anything that is not an explicitly opted-in target. Throws MintError.
 */
export function assertTargetAllowed({
  target,
  supabaseUrl,
  serviceRoleKey,
  env = process.env,
} = {}) {
  const info = classifySupabaseTarget({ supabaseUrl, serviceRoleKey });
  if (target === "local") {
    if (!info.isLocalHostname) {
      throw new MintError(
        `REFUSING TO RUN: resolved Supabase URL ${info.origin} is not a local stack ` +
          `(hostname "${info.hostname}"). This tool creates users and mints sessions; ` +
          `it will not touch a non-local project by accident.`,
        {
          code: "non_local_target",
          hint:
            `Start the local stack with \`pnpm supabase:up\`, and unset SUPABASE_URL / ` +
            `VITE_SUPABASE_URL / SUPABASE_PROJECT_URL if your shell sourced a hosted ` +
            `.env.supabase. To target a non-local project on purpose, pass ` +
            `--target remote and set ${REMOTE_OPT_IN_VARIABLE}=<project-ref>.`,
        },
      );
    }
    if (info.looksHosted) {
      throw new MintError(
        `REFUSING TO RUN: the resolved admin key belongs to a hosted Supabase project ` +
          `(issuer "${info.issuer || "unknown"}"${
            info.keyProjectRef ? `, project ref "${info.keyProjectRef}"` : ""
          }), even though the URL is local. Refusing to use a production admin key.`,
        {
          code: "hosted_key_for_local_target",
          hint:
            `Unset SUPABASE_SERVICE_ROLE_KEY / SERVICE_ROLE_KEY in this shell; the local ` +
            `stack's key is read from \`supabase status\`.`,
        },
      );
    }
    return info;
  }

  if (target !== "remote") {
    throw new MintError(`Unknown --target "${target}". Use "local" or "remote".`, {
      code: "unknown_target",
    });
  }

  const allowRef = String(env?.[REMOTE_OPT_IN_VARIABLE] ?? "").trim();
  if (!allowRef) {
    throw new MintError(
      `REFUSING TO RUN: --target remote requires ${REMOTE_OPT_IN_VARIABLE} to name the ` +
        `project ref you intend to write to. Two independent opt-ins are required on purpose.`,
      {
        code: "missing_remote_opt_in",
        hint: `${REMOTE_OPT_IN_VARIABLE}=<project-ref> node scripts/mint-test-user.mjs --target remote`,
      },
    );
  }
  if (info.isLocalHostname) {
    throw new MintError(
      `--target remote resolved to the local URL ${info.origin}. Use --target local instead.`,
      { code: "remote_target_is_local" },
    );
  }
  if (allowRef !== info.projectRef) {
    throw new MintError(
      `REFUSING TO RUN: ${REMOTE_OPT_IN_VARIABLE}="${allowRef}" does not match the resolved ` +
        `project ref "${info.projectRef}" (from ${info.origin}).`,
      { code: "remote_opt_in_mismatch" },
    );
  }
  if (info.keyProjectRef && info.keyProjectRef !== allowRef) {
    throw new MintError(
      `REFUSING TO RUN: the resolved admin key belongs to project "${info.keyProjectRef}", ` +
        `but ${REMOTE_OPT_IN_VARIABLE}="${allowRef}".`,
      { code: "remote_key_mismatch" },
    );
  }
  return info;
}

export function buildTestEmail({ now = Date.now(), suffix = "" } = {}) {
  const unique = suffix || randomBytes(4).toString("hex");
  return `${TEST_EMAIL_PREFIX}${now}-${unique}@${TEST_EMAIL_DOMAIN}`;
}

export function isManagedTestEmail(email) {
  const value = String(email ?? "").trim().toLowerCase();
  return (
    value.startsWith(TEST_EMAIL_PREFIX) && value.endsWith(`@${TEST_EMAIL_DOMAIN}`)
  );
}

export function isManagedTestUser(user) {
  const metadata = user?.user_metadata;
  if (metadata && typeof metadata === "object" && metadata[TEST_USER_MARKER] === true) {
    return true;
  }
  return false;
}

export function buildTestPassword() {
  // Long random password; the user is disposable and local-only by default.
  return `Ag3nt!${randomBytes(18).toString("base64url")}`;
}

export function buildTestOrgSlug({ suffix = "" } = {}) {
  return `${TEST_ORG_SLUG_PREFIX}${suffix || randomBytes(4).toString("hex")}`;
}

export function isManagedTestOrgSlug(slug) {
  return String(slug ?? "")
    .trim()
    .toLowerCase()
    .startsWith(TEST_ORG_SLUG_PREFIX);
}

/**
 * Normalizes the GoTrue token response into exactly what
 * `GoTrueClient._saveSession` persists: `JSON.stringify(session)` under the
 * derived storage key. auth-js 2.75.0 validates a stored row with
 * `_isValidSession`, which requires access_token, refresh_token and expires_at;
 * a missing `user` yields a proxy that throws on property access, so the full
 * user object is kept.
 */
export function normalizeSession(tokenResponse, { nowMs = Date.now() } = {}) {
  if (!tokenResponse || typeof tokenResponse !== "object") {
    throw new MintError("GoTrue returned an unexpected token response.", {
      code: "invalid_token_response",
    });
  }
  const session = { ...tokenResponse };
  if (!session.access_token || !session.refresh_token) {
    throw new MintError("GoTrue token response is missing access/refresh tokens.", {
      code: "invalid_token_response",
    });
  }
  if (typeof session.expires_at !== "number") {
    const expiresIn = Number(session.expires_in);
    session.expires_at =
      Math.round(nowMs / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600);
  }
  if (!session.token_type) {
    session.token_type = "bearer";
  }
  if (!session.user || typeof session.user !== "object") {
    throw new MintError(
      "GoTrue token response is missing the user object; the frontend would throw on it.",
      { code: "invalid_token_response" },
    );
  }
  return session;
}

export function buildSessionPayload({ session, supabaseUrl, target, password }) {
  const info = classifySupabaseTarget({ supabaseUrl });
  const storageKey = deriveStorageKey(supabaseUrl);
  return {
    email: session.user?.email ?? "",
    userId: session.user?.id ?? "",
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    supabaseUrl: trimSlash(supabaseUrl),
    storageKey,
    // Exactly the string to hand to localStorage.setItem(storageKey, value).
    localStorageValue: JSON.stringify(session),
    password,
    tokenType: session.token_type,
    expiresIn: session.expires_in ?? null,
    expiresAtIso: new Date(session.expires_at * 1000).toISOString(),
    target,
    projectRef: info.projectRef,
  };
}

export function redactSecrets(text, secrets = []) {
  let output = String(text ?? "");
  for (const secret of secrets) {
    const value = String(secret ?? "").trim();
    if (value.length >= 8) {
      output = output.split(value).join("[redacted]");
    }
  }
  return output;
}

export function parseArgs(argv = []) {
  const options = {
    target: "local",
    json: false,
    quiet: false,
    help: false,
    dryRun: false,
    cleanupUserIds: [],
    cleanupAll: false,
    seedOrg: null,
    email: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--quiet":
      case "-q":
        options.quiet = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--cleanup-all-test-users":
        options.cleanupAll = true;
        break;
      case "--seed-org":
        options.seedOrg = true;
        break;
      case "--no-seed-org":
        options.seedOrg = false;
        break;
      case "--target":
      case "--cleanup":
      case "--email": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new MintError(`${arg} requires a value.`, { code: "bad_usage" });
        }
        index += 1;
        if (arg === "--target") options.target = value;
        else if (arg === "--email") options.email = value;
        else options.cleanupUserIds.push(value);
        break;
      }
      default: {
        const equals = arg.indexOf("=");
        if (arg.startsWith("--") && equals > 2) {
          const name = arg.slice(0, equals);
          const value = arg.slice(equals + 1);
          if (name === "--target") {
            options.target = value;
            break;
          }
          if (name === "--email") {
            options.email = value;
            break;
          }
          if (name === "--cleanup") {
            options.cleanupUserIds.push(value);
            break;
          }
        }
        throw new MintError(`Unknown argument: ${arg}`, { code: "bad_usage" });
      }
    }
  }
  if (options.cleanupAll && options.target !== "local") {
    throw new MintError(
      "--cleanup-all-test-users is only allowed against the local stack. " +
        "Bulk deletion never runs against a remote target.",
      { code: "bulk_cleanup_remote" },
    );
  }
  if (options.seedOrg === null) {
    // Seeding an org is what makes the user useful to the controller
    // (projects/memberships). Only do it implicitly on the local stack.
    options.seedOrg = options.target === "local";
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Configuration resolution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the URL + keys through the shared local Supabase env helpers.
 *
 * For the local target, `supabase status` output WINS over process.env. The
 * helpers themselves prefer process.env, which is correct for their other
 * callers but wrong here: a shell that sourced the private .env.supabase would
 * supply a hosted URL and a matching hosted admin key. Sources are never mixed.
 */
export function resolveTargetConfig({ target, env = process.env, statusEnv = null } = {}) {
  if (target === "local" && statusEnv) {
    const supabaseUrl = resolveLocalSupabaseApiUrl({ env: EMPTY_ENV, statusEnv });
    if (supabaseUrl) {
      return {
        source: "supabase status",
        supabaseUrl,
        serviceRoleKey: resolveLocalSupabaseServiceRoleKey({ env: EMPTY_ENV, statusEnv }),
        anonKey: resolveLocalSupabaseAnonKey({ env: EMPTY_ENV, statusEnv }),
      };
    }
  }
  return {
    source: "process.env",
    supabaseUrl: resolveLocalSupabaseApiUrl({ env }),
    serviceRoleKey: resolveLocalSupabaseServiceRoleKey({ env }),
    anonKey: resolveLocalSupabaseAnonKey({ env }),
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

async function requestJson(url, { method = "GET", apiKey, body, headers = {}, secrets = [] }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MintError(`Request to ${url} failed: ${redactSecrets(message, secrets)}`, {
      code: "request_failed",
      hint: "Is the local Supabase stack running? Start it with `pnpm supabase:up`.",
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new MintError(
      `HTTP ${response.status} from ${url}: ${redactSecrets(text.slice(0, 500), secrets)}`,
      { code: "http_error" },
    );
  }
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MintError(
      `Non-JSON response from ${url}: ${redactSecrets(text.slice(0, 200), secrets)}`,
      { code: "invalid_response" },
    );
  }
}

async function waitForAuthReady({ apiUrl, apiKey, secrets, log }) {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/auth/v1/health`, {
        headers: { apikey: apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(`GoTrue health check never succeeded (${redactSecrets(lastError, secrets)}).`);
  throw new MintError(`GoTrue at ${apiUrl}/auth/v1/health did not become ready within 30s.`, {
    code: "auth_not_ready",
    hint: "Start the local stack with `pnpm supabase:up`.",
  });
}

/* -------------------------------------------------------------------------- */
/* Supabase operations                                                         */
/* -------------------------------------------------------------------------- */

async function createConfirmedUser({ apiUrl, serviceRoleKey, email, password, secrets }) {
  return requestJson(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    apiKey: serviceRoleKey,
    secrets,
    body: {
      email,
      password,
      // enable_confirmations = true in supabase/supabase/config.toml, so confirm
      // up front instead of round-tripping through the mail catcher.
      email_confirm: true,
      user_metadata: {
        [TEST_USER_MARKER]: true,
        created_by: "scripts/mint-test-user.mjs",
        created_at: new Date().toISOString(),
      },
    },
  });
}

async function signInWithPassword({ apiUrl, apiKey, email, password, secrets }) {
  return requestJson(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    apiKey,
    secrets,
    body: { email, password },
  });
}

async function deleteUser({ apiUrl, serviceRoleKey, userId, secrets }) {
  await requestJson(`${apiUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    apiKey: serviceRoleKey,
    secrets,
    body: { should_soft_delete: false },
  });
}

async function listUsers({ apiUrl, serviceRoleKey, secrets }) {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = await requestJson(
      `${apiUrl}/auth/v1/admin/users?page=${page}&per_page=200`,
      { apiKey: serviceRoleKey, secrets },
    );
    const batch = Array.isArray(body?.users) ? body.users : [];
    users.push(...batch);
    if (batch.length < 200) {
      break;
    }
  }
  return users;
}

async function seedOrgForUser({ apiUrl, serviceRoleKey, userId, email, secrets }) {
  const slug = buildTestOrgSlug();
  const created = await requestJson(`${apiUrl}/rest/v1/organizations`, {
    method: "POST",
    apiKey: serviceRoleKey,
    secrets,
    headers: { Prefer: "return=representation" },
    body: [{ slug, name: `Agent Test Org ${slug}`, billing_email: email }],
  });
  const org = Array.isArray(created) ? created[0] : created;
  if (!org?.id) {
    throw new MintError("Could not create the test organization.", { code: "seed_org_failed" });
  }
  await requestJson(`${apiUrl}/rest/v1/profiles`, {
    method: "POST",
    apiKey: serviceRoleKey,
    secrets,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [{ user_id: userId, default_org_id: org.id, full_name: "Agent Test User" }],
  });
  await requestJson(`${apiUrl}/rest/v1/org_memberships`, {
    method: "POST",
    apiKey: serviceRoleKey,
    secrets,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [{ org_id: org.id, user_id: userId, role: DEFAULT_ORG_ROLE }],
  });
  return { id: org.id, slug: org.slug ?? slug, role: DEFAULT_ORG_ROLE };
}

async function listManagedOrgIdsForUser({ apiUrl, serviceRoleKey, userId, secrets }) {
  const rows = await requestJson(
    `${apiUrl}/rest/v1/org_memberships?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=org_id,organizations(id,slug)`,
    { apiKey: serviceRoleKey, secrets },
  );
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => row?.organizations)
    .filter((org) => org?.id && isManagedTestOrgSlug(org.slug))
    .map((org) => ({ id: org.id, slug: org.slug }));
}

async function deleteOrphanManagedOrgs({ apiUrl, serviceRoleKey, orgs, secrets }) {
  const deleted = [];
  for (const org of orgs) {
    if (!isManagedTestOrgSlug(org.slug)) {
      continue;
    }
    const remaining = await requestJson(
      `${apiUrl}/rest/v1/org_memberships?org_id=eq.${encodeURIComponent(org.id)}&select=user_id`,
      { apiKey: serviceRoleKey, secrets },
    );
    if (Array.isArray(remaining) && remaining.length > 0) {
      continue;
    }
    await requestJson(
      `${apiUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(org.id)}`,
      { method: "DELETE", apiKey: serviceRoleKey, secrets, headers: { Prefer: "return=minimal" } },
    );
    deleted.push(org);
  }
  return deleted;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function printHelp() {
  const text = `
mint-test-user.mjs — create a throwaway Supabase user and print an injectable session.

Usage:
  node scripts/mint-test-user.mjs [options]

Options:
  --target <local|remote>     Target stack. Default: local.
  --email <address>           Use this email instead of a generated one.
  --seed-org / --no-seed-org  Create + attach a throwaway org (default: on for local).
  --cleanup <userId>          Delete a user this tool created (repeatable).
  --cleanup-all-test-users    Delete every user this tool created (local target only).
  --dry-run                   Resolve and safety-check the target, write nothing.
  --json                      Machine mode: JSON on stdout only, no progress notes.
  --quiet, -q                 Same as --json for progress output.
  --help, -h                  Show this help.

Output (stdout, JSON):
  { email, userId, accessToken, refreshToken, expiresAt, supabaseUrl,
    storageKey, localStorageValue, password, tokenType, expiresIn,
    expiresAtIso, target, projectRef, org }

  storageKey/localStorageValue are exactly what @supabase/supabase-js persists,
  so an agent can inject the session before the app boots:

    localStorage.setItem(storageKey, localStorageValue)

Safety:
  * Default target is the LOCAL stack, resolved from \`supabase status\`, not
    from process.env (a shell that sourced a private .env.supabase would
    otherwise supply hosted credentials).
  * A non-local URL, or an admin key with hosted-project claims, is refused.
  * A remote target requires BOTH --target remote and
    ${REMOTE_OPT_IN_VARIABLE}=<project-ref> matching the resolved URL.
  * --cleanup-all-test-users never runs against a remote target.
  * The service-role key is never printed.

Examples:
  pnpm supabase:up
  node scripts/mint-test-user.mjs --json > /tmp/session.json
  node scripts/mint-test-user.mjs --cleanup <userId> --json
`;
  process.stdout.write(`${text.trimStart()}\n`);
}

function announceTarget({ target, info, source, log }) {
  const summary = `target=${target} url=${info.origin} projectRef=${info.projectRef} (resolved from ${source})`;
  if (target === "remote") {
    // Always loud, even in machine mode: this is not the local stack.
    console.error(
      `[mint-test-user] !!! REMOTE TARGET — this is NOT the local stack. Creating real ` +
        `users on project "${info.projectRef}". !!!`,
    );
    console.error(`[mint-test-user] ${summary}`);
    return;
  }
  log(summary);
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    reportError(error);
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  const machineMode = options.json || options.quiet;
  const log = (message) => {
    if (!machineMode) {
      console.error(`[mint-test-user] ${message}`);
    }
  };

  try {
    const statusEnv =
      options.target === "local" ? readLocalSupabaseStatusEnv({ required: false }) : null;
    const config = resolveTargetConfig({ target: options.target, env, statusEnv });
    const info = assertTargetAllowed({
      target: options.target,
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
      env,
    });

    const apiUrl = trimSlash(config.supabaseUrl);
    const secrets = [config.serviceRoleKey].filter(Boolean);
    if (!config.serviceRoleKey) {
      throw new MintError("Could not resolve a Supabase service-role key.", {
        code: "missing_service_role_key",
        hint: "Start the local stack with `pnpm supabase:up`.",
      });
    }
    // GoTrue's token endpoint accepts any valid project key as `apikey`; prefer
    // the anon key so the admin key is used only for admin calls.
    const signInKey = config.anonKey || config.serviceRoleKey;

    announceTarget({ target: options.target, info, source: config.source, log });

    if (options.dryRun) {
      const payload = {
        dryRun: true,
        target: options.target,
        supabaseUrl: apiUrl,
        projectRef: info.projectRef,
        storageKey: deriveStorageKey(apiUrl),
        configSource: config.source,
        hasServiceRoleKey: Boolean(config.serviceRoleKey),
        hasAnonKey: Boolean(config.anonKey),
        wouldCreateEmail: options.email || buildTestEmail(),
        wouldSeedOrg: options.seedOrg,
      };
      process.stdout.write(`${JSON.stringify(payload, null, machineMode ? 0 : 2)}\n`);
      log("dry run only — nothing was created.");
      return 0;
    }

    await waitForAuthReady({ apiUrl, apiKey: signInKey, secrets, log });

    if (options.cleanupAll || options.cleanupUserIds.length > 0) {
      const payload = await runCleanup({
        apiUrl,
        serviceRoleKey: config.serviceRoleKey,
        options,
        secrets,
        log,
      });
      process.stdout.write(`${JSON.stringify(payload, null, machineMode ? 0 : 2)}\n`);
      return 0;
    }

    const email = options.email || buildTestEmail();
    const password = buildTestPassword();
    log(`creating confirmed user ${email} ...`);
    const user = await createConfirmedUser({
      apiUrl,
      serviceRoleKey: config.serviceRoleKey,
      email,
      password,
      secrets,
    });
    if (!user?.id) {
      throw new MintError("Admin user creation returned no user id.", {
        code: "create_user_failed",
      });
    }
    log(`created user ${user.id}`);

    let org = null;
    if (options.seedOrg) {
      org = await seedOrgForUser({
        apiUrl,
        serviceRoleKey: config.serviceRoleKey,
        userId: user.id,
        email,
        secrets,
      });
      log(`seeded org ${org.slug} (${org.id}) with role ${org.role}`);
    }

    const tokenResponse = await signInWithPassword({
      apiUrl,
      apiKey: signInKey,
      email,
      password,
      secrets,
    });
    const session = normalizeSession(tokenResponse);
    const payload = buildSessionPayload({
      session,
      supabaseUrl: apiUrl,
      target: options.target,
      password,
    });
    payload.org = org;

    process.stdout.write(`${JSON.stringify(payload, null, machineMode ? 0 : 2)}\n`);
    log(
      `session expires ${payload.expiresAtIso}; inject with ` +
        `localStorage.setItem(${JSON.stringify(payload.storageKey)}, <localStorageValue>)`,
    );
    log(`clean up with: node scripts/mint-test-user.mjs --cleanup ${payload.userId}`);
    return 0;
  } catch (error) {
    reportError(error);
    return 1;
  }
}

async function runCleanup({ apiUrl, serviceRoleKey, options, secrets, log }) {
  const deleted = [];
  const skipped = [];
  let targets = [];

  if (options.cleanupAll) {
    const users = await listUsers({ apiUrl, serviceRoleKey, secrets });
    targets = users.filter(isManagedTestUser);
    log(`found ${targets.length} user(s) created by this tool out of ${users.length} total.`);
  } else {
    for (const userId of options.cleanupUserIds) {
      const user = await requestJson(
        `${apiUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        { apiKey: serviceRoleKey, secrets },
      ).catch(() => null);
      if (!user?.id) {
        skipped.push({ userId, reason: "not found" });
        continue;
      }
      if (!isManagedTestUser(user)) {
        // Never delete a user this tool did not create.
        skipped.push({ userId, reason: `not created by this tool (missing ${TEST_USER_MARKER})` });
        continue;
      }
      targets.push(user);
    }
  }

  const orphanCandidates = [];
  for (const user of targets) {
    const orgs = await listManagedOrgIdsForUser({
      apiUrl,
      serviceRoleKey,
      userId: user.id,
      secrets,
    }).catch(() => []);
    await deleteUser({ apiUrl, serviceRoleKey, userId: user.id, secrets });
    deleted.push({ userId: user.id, email: user.email ?? "" });
    orphanCandidates.push(...orgs);
    log(`deleted ${user.email ?? user.id}`);
  }

  const deletedOrgs = await deleteOrphanManagedOrgs({
    apiUrl,
    serviceRoleKey,
    orgs: orphanCandidates,
    secrets,
  }).catch(() => []);

  return {
    cleanup: true,
    target: options.target,
    supabaseUrl: apiUrl,
    deletedUsers: deleted,
    deletedOrgs,
    skipped,
  };
}

function reportError(error) {
  if (error instanceof MintError) {
    console.error(`[mint-test-user] ${error.message}`);
    if (error.hint) {
      console.error(`[mint-test-user] hint: ${error.hint}`);
    }
    return;
  }
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[mint-test-user] unexpected failure: ${message}`);
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const code = await main();
  process.exitCode = code;
}
