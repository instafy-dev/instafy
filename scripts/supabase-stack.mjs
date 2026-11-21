#!/usr/bin/env node
/**
 * Lightweight helper to start/stop the local Supabase stack (Postgres, auth, etc.)
 * without booting the entire runtime/controller pipeline.
 *
 * Usage:
 *   pnpm supabase:up      # launches Supabase, applies migrations, prints env hints
 *   pnpm supabase:migrate # applies pending migrations to the already-running local stack
 *   pnpm supabase:reset   # rebuilds the running local database from supabase/migrations (deletes its data)
 *   pnpm supabase:down    # stops Supabase
 *
 * Each command exits with MIGRATIONS_COPY_EXIT_CODE (3) when it cannot refresh the Supabase CLI's
 * copy of supabase/migrations, before the CLI runs on that copy.
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
import { localSupabasePorts } from "./lib/localSupabasePorts.mjs";
import { ensureSupabaseEmailTemplateMounts } from "./lib/supabaseEmailTemplateMounts.mjs";
import { prepareSupabaseImageMirror } from "./lib/supabaseImageMirror.mjs";
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
// `pnpm test:e2e:supabase` tells a copy it could not refresh from a failed reset by this code: the
// stack is fine then, and recycling it would only stop it.
const MIGRATIONS_COPY_EXIT_CODE = 3;

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

// The Supabase CLI (--workdir supabase) reads migrations only from this ignored copy, so a copy
// that cannot be refreshed stops the run instead of building or migrating an old schema.
function syncSupabaseMigrationsDir() {
  if (!fileExists(supabaseMigrationsDir)) {
    throw migrationsCopyError(
      `${supabaseMigrationsDir} is missing; not running the Supabase CLI on ${supabaseProjectMigrationsDir}`
    );
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
    throw migrationsCopyError(
      `Unable to copy migrations into ${supabaseProjectMigrationsDir}: ${error.message}; not running the Supabase CLI on a stale copy`
    );
  }
}

function applySupabaseMigrations() {
  syncSupabaseMigrationsDir();
  console.log("[supabase-stack] Applying Supabase migrations...");
  runSupabase(["migration", "up", "--local"]);
}

// Exits with MIGRATIONS_COPY_EXIT_CODE (see the end of this file).
function migrationsCopyError(message) {
  return Object.assign(new Error(message), { code: "INSTAFY_MIGRATIONS_COPY" });
}

function readSupabaseEnv() {
  return readLocalSupabaseStatusEnv({ cwd: repoRoot, required: false });
}

function startSupabase() {
  const mode = resolveSupabaseStartMode(process.env.SUPABASE_DATABASE_ONLY, process.env.SUPABASE_AUTH_ONLY, process.env.SUPABASE_BROWSER_TEST);
  const databaseOnly = mode === "database";
  const authOnly = mode === "auth-email";
  const browserTest = mode === "browser-test";
  const startArgs = buildSupabaseStartArgs(process.env.SUPABASE_DATABASE_ONLY, {
    authOnly: process.env.SUPABASE_AUTH_ONLY,
    browserTest: process.env.SUPABASE_BROWSER_TEST,
  });
  syncSupabaseMigrationsDir();
  // Preparation failures must not enter the existing startup retry fallback.
  // The GHCR mirror pre-seeds the CLI's exact local image references (on by
  // default only under GitHub Actions), so neither the optional serial pull
  // nor the CLI contacts ECR Public for images it already has.
  prepareSupabaseImageMirror({ repoRoot, databaseOnly, authOnly, browserTest });
  prepareSupabaseSerialPull({ repoRoot, databaseOnly, authOnly, browserTest });
  console.log(
    databaseOnly
      ? "[supabase-stack] Starting database-only Supabase..."
      : authOnly ? "[supabase-stack] Starting Auth-only Supabase (five services)..."
        : browserTest ? "[supabase-stack] Starting browser-test Supabase (Edge Runtime excluded)..."
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
        browserTest: process.env.SUPABASE_BROWSER_TEST,
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
  const mode = resolveSupabaseStartMode(process.env.SUPABASE_DATABASE_ONLY, process.env.SUPABASE_AUTH_ONLY, process.env.SUPABASE_BROWSER_TEST);
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

function resetSupabase() {
  // Only ever the local stack, as for migrate: a stack that is not running is reported, not started.
  if (!readSupabaseEnv()) {
    throw new Error("local Supabase is not running; start it with 'pnpm supabase:up'");
  }
  // A raw `supabase db reset` rebuilds from whatever copy is there, which may be stale.
  syncSupabaseMigrationsDir();
  console.log("[supabase-stack] Rebuilding the local database from supabase/migrations (its data is deleted)...");
  runSupabase(["db", "reset", "--local", "--yes"]);
}

function printEnvHints(env) {
  // This stack's own status only. A shell may hold a hosted project's URL, database and
  // service-role key, which the shared resolvers read first and which this must never print.
  const local = { env: {}, statusEnv: env };
  const dbUrl = resolveLocalSupabaseDbUrl(local);
  const projectUrl = resolveLocalSupabaseApiUrl(local) || localSupabasePorts().apiUrl;
  const serviceRoleKey = resolveLocalSupabaseServiceRoleKey(local);

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
  if (action === "migrate") {
    // Only ever the local stack: `migration up --local` cannot reach another
    // database, and a stack that is not running is a setup problem to report,
    // not a reason to start one behind the caller's back.
    if (!readSupabaseEnv()) {
      throw new Error("local Supabase is not running; start it with 'pnpm supabase:up'");
    }
    applySupabaseMigrations();
    process.exit(0);
  }
  if (action === "reset") {
    resetSupabase();
    process.exit(0);
  }

  const { env } = ensureSupabase();
  printEnvHints(env);
} catch (error) {
  console.error(`[supabase-stack] ${error.message ?? error}`);
  process.exit(error?.code === "INSTAFY_MIGRATIONS_COPY" ? MIGRATIONS_COPY_EXIT_CODE : 1);
}
