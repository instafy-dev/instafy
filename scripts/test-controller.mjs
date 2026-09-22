#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseDbUrl,
} from "./lib/localSupabaseEnv.mjs";
import {
  SKIP_MIGRATIONS_ENV,
  shouldApplyLocalMigrations,
} from "./lib/controllerTestMigrations.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
  if ((result.status ?? result.code ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function resolveExplicitDatabaseUrl() {
  return resolveLocalSupabaseDbUrl({ env: process.env });
}

function ensureSupabaseEnv() {
  const existingEnv = readLocalSupabaseStatusEnv({ cwd: repoRoot, required: false });
  if (existingEnv) {
    // `supabase:up` migrates on start; an already-running stack has to be
    // brought up to date here or the suite runs against a stale schema.
    if (shouldApplyLocalMigrations({ explicitDbUrl: null, env: process.env })) {
      console.log(
        `[test-controller] Applying pending migrations to the local stack (set ${SKIP_MIGRATIONS_ENV}=1 to skip)...`
      );
      run("pnpm", ["supabase:migrate"]);
    }
    return existingEnv;
  }

  console.warn(
    `[test-controller] Local Supabase is not ready. Starting it via 'pnpm supabase:up'...`
  );
  run("pnpm", ["supabase:up"]);
  return readLocalSupabaseStatusEnv({ cwd: repoRoot, required: true });
}

function printUsage() {
  console.log(`Usage:
  pnpm test:controller
  pnpm test:controller <test_name> -- --nocapture

Examples:
  pnpm test:controller conversation_message_routes_preserve_inline_reference_content -- --nocapture
  TEST_DATABASE_URL=postgresql://... pnpm test:controller record_controller_assistant_message_preserves_inline_reference_content

Against the local stack, pending migrations are applied first. An explicit
TEST_DATABASE_URL is used as given and never migrated. Set ${SKIP_MIGRATIONS_ENV}=1
to test the local stack exactly as it is.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const explicitDbUrl = resolveExplicitDatabaseUrl();
  const statusEnv = explicitDbUrl ? null : ensureSupabaseEnv();
  const dbUrl = explicitDbUrl || resolveLocalSupabaseDbUrl({ env: process.env, statusEnv });
  if (!dbUrl) {
    throw new Error(
      "[test-controller] Unable to resolve a database URL. Export TEST_DATABASE_URL explicitly or run 'pnpm supabase:up' first."
    );
  }

  console.log(`[test-controller] Using TEST_DATABASE_URL=${dbUrl}`);
  const cargoArgs = [
    "test",
    "--manifest-path",
    "packages/runtime-controller/Cargo.toml",
    ...process.argv.slice(2),
  ];
  run("cargo", cargoArgs, {
    env: {
      ...process.env,
      TEST_DATABASE_URL: dbUrl,
      DATABASE_URL: dbUrl,
      RUST_TEST_THREADS: "1",
    },
  });
}

try {
  main();
} catch (error) {
  console.error(error.message ?? error);
  process.exit(1);
}
