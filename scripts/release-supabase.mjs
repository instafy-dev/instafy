#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supabaseWorkdir = join(rootDir, "supabase");
const supabaseProjectDir = join(supabaseWorkdir, "supabase");
const sqlDir = join(supabaseWorkdir, "sql");
const migrationsDir = join(rootDir, "supabase", "migrations");
const supabaseMigrationsDir = join(supabaseProjectDir, "migrations");
const projectRefPath = join(supabaseProjectDir, ".temp", "project-ref");
const functionsDir = join(supabaseProjectDir, "functions");

const args = process.argv.slice(2);
const skipMigrations = args.includes("--skip-migrations");
const skipFunctions = args.includes("--skip-functions");

function runStep(label, command) {
  console.log(`\n• ${label}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", cwd: rootDir });
  if (result.status !== 0) {
    console.error(`\n✖ Failed during: ${label}`);
    process.exit(result.status ?? 1);
  }
}

function runSupabase(label, supabaseArgs) {
  runStep(label, ["pnpm", "exec", "supabase", "--workdir", "supabase", ...supabaseArgs]);
}

function collectFunctions() {
  try {
    return readdirSync(functionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    console.warn("No functions directory found at", functionsDir, error.message ?? error);
    return [];
  }
}

function syncSupabaseMigrations() {
  if (!existsSync(migrationsDir)) {
    return;
  }

  fs.mkdirSync(supabaseProjectDir, { recursive: true });
  fs.rmSync(supabaseMigrationsDir, { recursive: true, force: true });
  fs.cpSync(migrationsDir, supabaseMigrationsDir, {
    dereference: true,
    errorOnExist: false,
    force: true,
    recursive: true,
  });
}

(function main() {
  console.log("Instafy Supabase release helper\n");

  const projectRef = existsSync(projectRefPath)
    ? readFileSync(projectRefPath, "utf-8").trim()
    : "";
  if (!projectRef) {
    console.error(
      "No Supabase project linked. Run `pnpm exec supabase --workdir supabase link --project-ref <ref>` before executing the release script."
    );
    process.exit(1);
  }

  if (!skipMigrations) {
    if (existsSync(sqlDir)) {
      const legacySql = readdirSync(sqlDir).filter((file) => file.endsWith(".sql"));
      if (legacySql.length) {
        console.warn(
          "Found raw SQL files under supabase/sql/. Convert them into formal migrations under supabase/migrations before running releases."
        );
      }
    }

    if (!existsSync(migrationsDir)) {
      console.log("No supabase/migrations directory found. Skipping database push.");
    } else {
      syncSupabaseMigrations();
      runSupabase("Push database migrations", ["db", "push", "--include-all"]);
    }
  } else {
    console.log("Skipping SQL migrations (--skip-migrations).");
  }

  if (!skipFunctions) {
    const functions = collectFunctions();
    for (const fn of functions) {
      const label = `Deploy function: ${fn}`;
      runSupabase(label, ["functions", "deploy", fn]);
    }
  } else {
    console.log("Skipping function deploys (--skip-functions).");
  }

  console.log("\n✓ Supabase release tasks completed.");
})();
