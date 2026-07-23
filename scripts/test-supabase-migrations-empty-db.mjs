#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePublicMigrationTrack } from "./check-supabase-migrations.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");
const POSTGRES_IMAGE =
  "public.ecr.aws/supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab";
const START_ATTEMPTS = 90;
const START_RETRY_MS = 1_000;
const REQUIRED_PUBLIC_RELATIONS = [
  "organizations",
  "projects",
  "runtime_providers",
  "user_credentials",
];

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "")
      .trim()
      .slice(-4_000);
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function wait(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function validateMigrationPlan(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error("migration plan must contain at least one migration");
  }
  const versions = new Set();
  for (const migration of migrations) {
    const version = migration?.version?.toString();
    if (
      !migration ||
      typeof migration.fileName !== "string" ||
      !/^[0-9]{14}_[a-z0-9][a-z0-9_]*\.sql$/u.test(migration.fileName) ||
      typeof migration.source !== "string" ||
      !["public", "private"].includes(migration.track) ||
      !/^[0-9]{14}$/u.test(version ?? "")
    ) {
      throw new Error("migration plan contains an invalid entry");
    }
    if (versions.has(version)) {
      throw new Error(`migration plan contains duplicate version ${version}`);
    }
    versions.add(version);
  }
}

function runEmptyDatabaseMigrationTest({
  label,
  migrations,
  dockerCommand = "docker",
} = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(label ?? "")) {
    throw new Error("migration test label is invalid");
  }
  validateMigrationPlan(migrations);

  commandResult(dockerCommand, ["version"]);
  const containerName = `instafy-migrations-${label}-${process.pid}-${randomBytes(4).toString("hex")}`;
  let started = false;
  try {
    commandResult(dockerCommand, [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--env",
      "POSTGRES_PASSWORD=postgres",
      POSTGRES_IMAGE,
    ]);
    started = true;

    let ready = false;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      const readiness = spawnSync(
        dockerCommand,
        [
          "exec",
          containerName,
          "pg_isready",
          "--username",
          "postgres",
          "--dbname",
          "postgres",
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      const health = spawnSync(
        dockerCommand,
        [
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          containerName,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      if (
        !readiness.error &&
        readiness.status === 0 &&
        !health.error &&
        health.status === 0 &&
        health.stdout.trim() === "healthy"
      ) {
        ready = true;
        break;
      }
      wait(START_RETRY_MS);
    }
    if (!ready) {
      throw new Error("disposable PostgreSQL did not become ready");
    }

    for (const migration of migrations) {
      const sql = readFileSync(migration.source);
      commandResult(
        dockerCommand,
        [
          "exec",
          "--interactive",
          containerName,
          "psql",
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=1",
          "--single-transaction",
          "--username",
          "postgres",
          "--dbname",
          "postgres",
        ],
        { input: sql },
      );
      console.log(
        `[empty-db:${label}] applied ${migration.track}:${migration.fileName}`,
      );
    }

    const relationQuery = REQUIRED_PUBLIC_RELATIONS.map(
      (relation) => `to_regclass('public.${relation}') is not null`,
    ).join(" and ");
    const verification = commandResult(dockerCommand, [
      "exec",
      containerName,
      "psql",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--command",
      `select (${relationQuery})::text;`,
    ]);
    if (verification.stdout.trim() !== "true") {
      throw new Error("required public relations are missing after migration");
    }
    console.log(
      `[empty-db:${label}] PASS (${migrations.length} migration(s), ${REQUIRED_PUBLIC_RELATIONS.length} required relations)`,
    );
  } finally {
    if (started) {
      spawnSync(dockerCommand, ["rm", "--force", containerName], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      });
    }
  }
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error("test-supabase-migrations-empty-db.mjs does not accept arguments");
  }
  const migrations = validatePublicMigrationTrack();
  runEmptyDatabaseMigrationTest({
    label: "public",
    migrations,
  });
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Empty-database migration test failed: ${error.message}`
        : "Empty-database migration test failed",
    );
    process.exitCode = 1;
  }
}

export {
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
  runEmptyDatabaseMigrationTest,
  validateMigrationPlan,
};
