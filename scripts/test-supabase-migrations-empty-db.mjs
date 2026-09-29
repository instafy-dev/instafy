#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LANE_BOUNDARY,
  validatePublicMigrationTrack,
} from "./check-supabase-migrations.mjs";
import {
  cacheTagFor,
  pullPinnedImage,
} from "./ensure-supabase-postgres-image.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");
const POSTGRES_IMAGE =
  "public.ecr.aws/supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab";

// A cache-loaded image cannot be addressed by name@digest (docker load does
// not restore RepoDigests), so ensure-supabase-postgres-image.mjs tags it with
// a digest-derived local name at pull time. Prefer the exact digest reference
// when the daemon can resolve it; fall back to the cache tag, whose name binds
// the same digest. When neither is present, explicitly pull the exact digest
// with bounded retries. The later `docker run --pull never` cannot make an
// unbounded implicit registry request of its own.
function resolveRunnableImage(
  dockerCommand,
  { spawnCommand = spawnSync, pullImage = pullPinnedImage } = {},
) {
  for (const candidate of [POSTGRES_IMAGE, cacheTagFor(POSTGRES_IMAGE)]) {
    const inspect = spawnCommand(dockerCommand, ["image", "inspect", candidate], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (inspect.status === 0) {
      return candidate;
    }
  }
  pullImage(POSTGRES_IMAGE, { docker: dockerCommand });
  return POSTGRES_IMAGE;
}
const START_ATTEMPTS = 90;
const START_RETRY_MS = 1_000;
const REQUIRED_PUBLIC_RELATIONS = [
  "organizations",
  "projects",
  "runtime_providers",
  "user_credentials",
];
// Live requests lock any two of these tables in both orders. Completion and
// the expired-job sweep update agent_jobs and then write the credit ledger,
// while dispatch and deferred billing write the ledger and then agent_jobs.
// An insert into the ledger locks it and then runs a trigger that writes and
// locks the org's org_credit_balances row, while a credit burn inserts or
// locks that row for its daily refill before it inserts into the ledger, and
// dispatch burns credits before it writes agent_jobs. A migration that holds a
// conflicting lock on two of the tables until it commits can therefore
// deadlock a live request, whichever table it locks first. After the lane
// boundary a migration may hold such a lock on one of the tables and only read
// the others; a change to two of them is split into migrations that commit
// separately.
const BOTH_ORDER_TABLES = ["agent_jobs", "org_credit_ledger", "org_credit_balances"];
const BOTH_ORDER_TABLE_PAIRS = BOTH_ORDER_TABLES.flatMap((left, index) =>
  BOTH_ORDER_TABLES.slice(index + 1).map((right) => [left, right]),
);
// The table lock modes a live write can end up waiting on. SHARE and stronger
// block a live INSERT, UPDATE or DELETE outright. ROW SHARE and ROW EXCLUSIVE
// block no live write themselves, but they come with SELECT ... FOR UPDATE and
// with INSERT, UPDATE or DELETE, whose row locks a live write of the same row
// waits on. Postgres takes these table locks even when a statement matches no
// rows, so the empty database still shows them. ACCESS SHARE (a plain read) and
// SHARE UPDATE EXCLUSIVE conflict with no live write. Locks taken only for a
// row that exists, such as a foreign-key check or a row trigger that writes
// another of the tables, cannot show on an empty database.
const CONFLICTING_LOCK_MODES = new Set([
  "RowShareLock",
  "RowExclusiveLock",
  "ShareLock",
  "ShareRowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
]);
const HELD_LOCK_MARKER = "instafy-migration-holds";
const TRANSACTION_MARKER = "instafy-migration-xact";
// psql runs it first in the one transaction it opens for a migration, before
// the migration itself. It prints the id of that transaction.
const TRANSACTION_QUERY = `select '${TRANSACTION_MARKER} ' || pg_current_xact_id();`;
// psql runs it after the migration in the same transaction, before COMMIT,
// while every lock the migration took is still held. It prints the id of the
// transaction it runs in, then one row per table and lock mode.
const HELD_LOCK_QUERY = `select '${TRANSACTION_MARKER} ' || pg_current_xact_id()
union all
select '${HELD_LOCK_MARKER} ' || c.relname || ' ' || l.mode
from pg_locks l
join pg_class c on c.oid = l.relation
where l.pid = pg_backend_pid()
  and l.granted
  and c.relnamespace = 'public'::regnamespace
  and c.relname in (${BOTH_ORDER_TABLES.map((table) => `'${table}'`).join(", ")});
`;
const TRANSACTION_WARNINGS = [
  "there is already a transaction in progress",
  "there is no transaction in progress",
];

// Why HELD_LOCK_QUERY did not read the migration's own locks, or null when it
// did. A top-level COMMIT, END or ROLLBACK in the migration, or COMMIT AND
// CHAIN, ends the transaction psql opened for it early, and the probe then
// runs in a later transaction that holds none of the locks the migration took
// before that. The probe prints the same id as TRANSACTION_QUERY only while
// that first transaction is still open. psql also warns when the migration
// opens a transaction of its own with BEGIN.
function heldLockProbeProblem(stdout, stderr) {
  const ids = [];
  for (const line of String(stdout).split("\n")) {
    const [marker, id, ...rest] = line.trim().split(" ");
    if (marker === TRANSACTION_MARKER && rest.length === 0) {
      ids.push(id);
    }
  }
  if (ids.length !== 2 || !/^[0-9]+$/u.test(ids[0]) || ids[0] !== ids[1]) {
    return `transaction ids ${ids.join(", ") || "missing"}`;
  }
  const warning = TRANSACTION_WARNINGS.find((text) => String(stderr).includes(text));
  return warning ? `psql warned "${warning}"` : null;
}

// The pairs on both of whose tables a migration's HELD_LOCK_QUERY output
// reports a conflicting lock.
function bothOrderLockViolations(psqlOutput) {
  const held = new Set();
  for (const line of String(psqlOutput).split("\n")) {
    const [marker, table, mode, ...rest] = line.trim().split(" ");
    if (
      marker === HELD_LOCK_MARKER &&
      rest.length === 0 &&
      CONFLICTING_LOCK_MODES.has(mode)
    ) {
      held.add(table);
    }
  }
  return BOTH_ORDER_TABLE_PAIRS.filter(
    ([left, right]) => held.has(left) && held.has(right),
  );
}

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
      "--pull",
      "never",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--env",
      "POSTGRES_PASSWORD=postgres",
      resolveRunnableImage(dockerCommand),
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
      const checkHeldLocks = BigInt(migration.version) > LANE_BOUNDARY;
      // With --single-transaction, psql runs its commands in order inside one
      // transaction: the id query, the migration from stdin, then the probe.
      const applied = commandResult(
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
          ...(checkHeldLocks
            ? [
                "--command",
                TRANSACTION_QUERY,
                "--file",
                "-",
                "--command",
                HELD_LOCK_QUERY,
              ]
            : []),
        ],
        { input: readFileSync(migration.source) },
      );
      if (checkHeldLocks) {
        const problem = heldLockProbeProblem(applied.stdout, applied.stderr);
        if (problem) {
          throw new Error(
            `${migration.track}:${migration.fileName} does not run in the one transaction psql opens for it, so its held locks cannot be checked (${problem}); remove its own BEGIN, COMMIT, END or ROLLBACK`,
          );
        }
        const violations = bothOrderLockViolations(applied.stdout);
        if (violations.length > 0) {
          throw new Error(
            `${migration.track}:${migration.fileName} writes or locks both ${violations
              .map((pair) => pair.join(" and "))
              .join(", ")} until it commits; split it into migrations that commit separately`,
          );
        }
      }
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
  BOTH_ORDER_TABLE_PAIRS,
  BOTH_ORDER_TABLES,
  HELD_LOCK_QUERY,
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
  TRANSACTION_QUERY,
  bothOrderLockViolations,
  heldLockProbeProblem,
  resolveRunnableImage,
  runEmptyDatabaseMigrationTest,
  validateMigrationPlan,
};
