#!/usr/bin/env node
/**
 * Lightweight helper to start/stop the local Supabase stack (Postgres, auth, etc.)
 * without booting the entire runtime/controller pipeline.
 *
 * Usage:
 *   pnpm supabase:up   # launches Supabase, applies migrations, prints env hints
 *   pnpm supabase:down # stops Supabase
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseDbUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "./lib/localSupabaseEnv.mjs";
import { ensureSupabaseEmailTemplateMounts } from "./lib/supabaseEmailTemplateMounts.mjs";
import { prepareSupabaseSerialPull } from "./lib/supabaseSerialPull.mjs";
import {
  buildSupabaseStartArgs,
  resolveSupabaseStartMode,
} from "./lib/supabaseStartMode.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const supabaseProjectDir = path.join(repoRoot, "supabase", "supabase");
const supabaseMigrationsDir = path.join(repoRoot, "supabase", "migrations");
const supabaseProjectMigrationsDir = path.join(supabaseProjectDir, "migrations");
const supabaseFlag = path.join(repoRoot, "tmp", ".runtime-supabase-started");

const action = process.argv[2] ?? "up";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
  const exitCode = result.status ?? result.code ?? 1;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
  }
}

function runSupabase(args, options = {}) {
  run("pnpm", ["exec", "supabase", "--workdir", "supabase", ...args], options);
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureTmpDir() {
  const tmpDir = path.dirname(supabaseFlag);
  if (!fileExists(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
}

function syncSupabaseMigrationsDir() {
  if (!fileExists(supabaseMigrationsDir)) {
    return;
  }
  try {
    fs.mkdirSync(supabaseProjectDir, { recursive: true });
    fs.rmSync(supabaseProjectMigrationsDir, { recursive: true, force: true });
    fs.cpSync(supabaseMigrationsDir, supabaseProjectMigrationsDir, {
      dereference: true,
      errorOnExist: false,
      force: true,
      recursive: true,
    });
  } catch (error) {
    console.warn(
      `[supabase-stack] Unable to copy migrations into ${supabaseProjectMigrationsDir}: ${error.message}`
    );
  }
}

function applySupabaseMigrations() {
  syncSupabaseMigrationsDir();
  console.log("[supabase-stack] Applying Supabase migrations...");
  runSupabase(["migration", "up", "--local"]);
}

function readSupabaseEnv() {
  return readLocalSupabaseStatusEnv({ cwd: repoRoot, required: false });
}

function startSupabase() {
  const mode = resolveSupabaseStartMode(process.env.SUPABASE_DATABASE_ONLY, process.env.SUPABASE_AUTH_ONLY);
  const databaseOnly = mode === "database";
  const authOnly = mode === "auth-email";
  const startArgs = buildSupabaseStartArgs(process.env.SUPABASE_DATABASE_ONLY, {
    authOnly: process.env.SUPABASE_AUTH_ONLY,
  });
  syncSupabaseMigrationsDir();
  // Preparation failures must not enter the existing startup retry fallback.
  prepareSupabaseSerialPull({ repoRoot, databaseOnly, authOnly });
  console.log(
    databaseOnly
      ? "[supabase-stack] Starting database-only Supabase..."
      : authOnly ? "[supabase-stack] Starting Auth-only Supabase (five services)..."
        : "[supabase-stack] Starting Supabase local stack...",
  );
  try {
    runSupabase(startArgs);
  } catch (error) {
    console.warn(`[supabase-stack] Supabase start failed: ${error.message}`);
    console.warn(
      databaseOnly
        ? "[supabase-stack] Retrying Supabase Postgres startup..."
        : "[supabase-stack] Retrying with --ignore-health-check...",
    );
    try {
      runSupabase(["stop"]);
    } catch (stopError) {
      console.warn(`[supabase-stack] Supabase stop after failed start: ${stopError.message}`);
    }
    runSupabase(
      buildSupabaseStartArgs(process.env.SUPABASE_DATABASE_ONLY, {
        ignoreHealthCheck: !databaseOnly,
        authOnly: process.env.SUPABASE_AUTH_ONLY,
      }),
    );
  }
  if (!databaseOnly) {
    ensureSupabaseEmailTemplateMounts({ projectDir: supabaseProjectDir });
  }
  ensureTmpDir();
  fs.writeFileSync(supabaseFlag, String(Date.now()));
  applySupabaseMigrations();
  const env = readSupabaseEnv() ?? {};
  return { env, started: true };
}

function ensureSupabase() {
  const mode = resolveSupabaseStartMode(process.env.SUPABASE_DATABASE_ONLY, process.env.SUPABASE_AUTH_ONLY);
  const databaseOnly = mode === "database";
  const existingEnv = readSupabaseEnv();
  if (existingEnv) {
    console.log("[supabase-stack] Supabase already running.");
    if (!databaseOnly) {
      ensureSupabaseEmailTemplateMounts({ projectDir: supabaseProjectDir });
    }
    applySupabaseMigrations();
    return { env: existingEnv, started: false };
  }
  return startSupabase();
}

function stopSupabase() {
  console.log("[supabase-stack] Stopping Supabase local stack...");
  try {
    runSupabase(["stop"]);
  } catch (error) {
    console.warn(`[supabase-stack] Supabase stop failed: ${error.message}`);
  } finally {
    try {
      fs.rmSync(supabaseFlag, { force: true });
    } catch {}
  }
}

function printEnvHints(env) {
  const dbUrl = resolveLocalSupabaseDbUrl({ statusEnv: env });
  const projectUrl =
    resolveLocalSupabaseApiUrl({ statusEnv: env }) || "http://127.0.0.1:54321";
  const serviceRoleKey = resolveLocalSupabaseServiceRoleKey({ statusEnv: env });

  console.log("\n[supabase-stack] Supabase is ready.");
  if (dbUrl) {
    console.log(`  DATABASE_URL:       ${dbUrl}`);
    console.log("  (use this for cargo run or integration tests)");
  } else {
    console.log("  DATABASE_URL:       <not reported – run `supabase status --output env`>");
  }
  if (env.ANON_KEY) {
    console.log(`  ANON_KEY:           ${env.ANON_KEY}`);
  }
  if (serviceRoleKey) {
    console.log(`  SERVICE_ROLE_KEY:   ${serviceRoleKey}`);
  }
  console.log(`  SUPABASE_PROJECT_URL: ${projectUrl}`);

  console.log("\nTo run controller integration tests:");
  console.log("  pnpm test:controller");
  console.log(
    "  pnpm test:controller conversation_message_routes_preserve_inline_reference_content -- --nocapture\n"
  );
}

try {
  if (action === "down") {
    stopSupabase();
    process.exit(0);
  }

  const { env } = ensureSupabase();
  printEnvHints(env);
} catch (error) {
  console.error(`[supabase-stack] ${error.message ?? error}`);
  process.exit(1);
}
