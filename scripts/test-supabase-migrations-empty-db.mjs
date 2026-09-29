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
// Live requests write these tables in one transaction, each in both orders
// with another of them. Dispatch inserts the prompt, the run and the user's
// message, which updates its conversation, then burns credits and inserts the
// agent_jobs row. Completion and cancel update agent_jobs and then the run,
// and completion then writes the ledger and the agent's message and its
// conversation; the expired-job sweep also updates agent_jobs before the
// ledger. Deferred billing writes the ledger and then the prompt, the run,
// agent_jobs and the message. An insert into the ledger locks it and then
// runs a trigger that writes and locks the org's org_credit_balances row,
// while a credit burn inserts or locks that row for its daily refill before it
// inserts into the ledger. Dispatch also writes runtimes and runtime_events,
// and through the insert trigger on conversation_messages the notification
// tables, before it inserts agent_jobs, and records a new conversation's
// activity_events row before its run and job. Lease and heartbeat update
// runtimes before agent_jobs. A runtime stop updates agent_jobs before
// runtimes and runtime_events, and completion updates agent_jobs and the run
// before its activity_events and runtime_events rows and its reply, whose
// trigger writes the notification tables. A steer inserts the user's message
// and then its agent_job_inputs row, while an input acknowledgement updates
// agent_job_inputs and then the message. Dispatch adds the sender to
// conversation_participants before it inserts agent_jobs, while a steer locks
// agent_jobs and then adds the sender. A provider-managed stop marks its
// runtime_leases row cleanup pending before it requeues agent_jobs, then
// updates agent_jobs before it releases the lease. Creating or editing an
// automation writes its conversation and then automations, while a launch
// failure updates automations and then posts a notice to the conversation. A
// support acknowledgement updates bug_reports and then notification_recipients,
// while marking a support notification read updates them the other way round.
// A support or customer reply inserts into bug_report_messages and then
// updates bug_reports, while a status change updates bug_reports and then
// posts a system message. A user's first dispatch creates their agent in
// user_agents after a new conversation and its participant, or before the
// message's conversation update and participant in an existing conversation.
// Ensuring a new runtime records its runtime_events row before it inserts
// origin_instances, while a stop releases origin_instances before its event.
// Delivering a notification updates notification_delivery_jobs and then its
// notification_delivery_attempts row, while leasing a job whose lease expired
// updates the attempt first. A migration that holds a conflicting lock on two
// of the tables until it commits can therefore deadlock a live request, or a
// chain of requests that each hold one of the tables while they wait for the
// next, whichever table it locks first. After the lane boundary a change to
// two of them is split into migrations that commit separately. The list comes
// from a code audit of the controller's transactions, so it is best effort;
// MIGRATIONS.md describes the backstop for a table it misses.
const BOTH_ORDER_TABLES = [
  "agent_jobs",
  "org_credit_ledger",
  "org_credit_balances",
  "runs",
  "prompts",
  "conversations",
  "conversation_messages",
  "runtimes",
  "notification_events",
  "notification_recipients",
  "notification_delivery_jobs",
  "agent_job_inputs",
  "activity_events",
  "runtime_events",
  "conversation_participants",
  "runtime_leases",
  "automations",
  "bug_reports",
  "bug_report_messages",
  "origin_instances",
  "notification_delivery_attempts",
  "user_agents",
];
// The tables of BOTH_ORDER_TABLES that a migration after the lane boundary
// created, by the version of that migration. Every other table of the list
// existed by the lane boundary. A table is expected among the public tables
// before every migration after the one that created it.
const BOTH_ORDER_TABLES_CREATED_BY = new Map([
  ["agent_job_inputs", 20260816213318n],
  ["activity_events", 20260902200000n],
  ["bug_report_messages", 20260905120000n],
  ["notification_events", 20260906120000n],
  ["notification_recipients", 20260906120000n],
  ["notification_delivery_jobs", 20260906120000n],
  ["notification_delivery_attempts", 20260906120000n],
]);
// Migrations already on main that the rules below reject only because tables
// after the first three joined the list after them. History is append-only,
// so these are checked against the first three tables only.
const FIRST_THREE_TABLES_ONLY = new Set([
  20260816213316n,
  20260816213318n,
  20260906120000n,
]);

function tablePairs(tables) {
  return tables.flatMap((left, index) =>
    tables.slice(index + 1).map((right) => [left, right]),
  );
}

const BOTH_ORDER_TABLE_PAIRS = tablePairs(BOTH_ORDER_TABLES);
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
// The same requests also read and row-lock other tables between their writes
// to those, in both orders: a refill locks the org's balance row and then
// inserts into the ledger, whose foreign-key check row-locks the
// organization; credit status reads org_subscriptions after that balance lock;
// completion updates agent_jobs and then reads projects. So a migration that
// holds a conflicting lock on one of BOTH_ORDER_TABLES may hold none of these
// modes on any other table that existed before it: ACCESS EXCLUSIVE blocks
// even a read, EXCLUSIVE blocks a row lock, and ROW SHARE and ROW EXCLUSIVE
// come with the migration's own row locks, which a request that locks the same
// row waits on. SHARE and SHARE ROW EXCLUSIVE, which an index or a foreign key
// takes, block only a write to that other table and stay allowed, because the
// audit behind BOTH_ORDER_TABLES, which covered every table the controller
// writes and the triggers and functions that write for it, found no other
// table that live requests write both before and after the same table of the
// list; MIGRATIONS.md describes the lock order they still depend on. A table
// that live requests come to write in both orders with one of them belongs in
// BOTH_ORDER_TABLES.
const OTHER_TABLE_LOCK_MODES = new Set([
  "RowShareLock",
  "RowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
]);
const EXISTING_RELATION_MARKER = "instafy-migration-existing";
const HELD_LOCK_MARKER = "instafy-migration-holds";
const TRANSACTION_MARKER = "instafy-migration-xact";
// Both probe queries first set search_path to pg_catalog alone, so that no
// table, view, function or operator a migration creates, in public or as a
// temporary object, stands in for a catalog one.
const CATALOG_SEARCH_PATH = "set local search_path = pg_catalog, pg_temp;";
// psql runs it first in the one transaction it opens for a migration, before
// the migration itself. It prints the id of that transaction, then one row per
// public relation that exists before the migration: its oid and the table it
// belongs to, which for an index is the table the index is on. It then sets
// search_path back to the session's default for the migration.
//
// Because it runs first, a migration whose first statement is SET TRANSACTION
// ISOLATION LEVEL, which Postgres accepts only before a transaction's first
// query, fails this test with "must be called before any query", although
// supabase db push would apply it. No migration does that.
const TRANSACTION_QUERY = `${CATALOG_SEARCH_PATH}
select '${TRANSACTION_MARKER} ' || pg_current_xact_id()
union all
select '${EXISTING_RELATION_MARKER} ' || c.oid || ' ' || coalesce(t.relname, c.relname)
from pg_class c
left join pg_index i on i.indexrelid = c.oid
left join pg_class t on t.oid = i.indrelid
where c.relnamespace = 'public'::regnamespace;
set local search_path to default;
`;
// psql runs it after the migration in the same transaction, before COMMIT,
// while every lock the migration took is still held. It prints the id of the
// transaction it runs in, then one row per relation lock the transaction holds
// on a public relation, or on one it dropped: the relation's oid and the mode.
const HELD_LOCK_QUERY = `${CATALOG_SEARCH_PATH}
select '${TRANSACTION_MARKER} ' || pg_current_xact_id()
union all
select '${HELD_LOCK_MARKER} ' || l.relation || ' ' || l.mode
from pg_locks l
left join pg_class c on c.oid = l.relation
where l.pid = pg_backend_pid()
  and l.granted
  and l.locktype = 'relation'
  and (c.oid is null or c.relnamespace = 'public'::regnamespace);
`;
const TRANSACTION_WARNINGS = [
  "there is already a transaction in progress",
  "there is no transaction in progress",
];
// Linux limits one argument of a process, its terminating NUL included, to
// 128 KiB, and the runner passes a checked migration to psql as one.
const MAX_COMMAND_BYTES = 128 * 1024 - 1;

// The rows of one marker in psql's output, as [oid, the rest of the row].
function markedRows(psqlOutput, wanted) {
  const rows = [];
  for (const line of String(psqlOutput).split("\n")) {
    const [marker, oid, ...rest] = line.trim().split(" ");
    if (marker === wanted && rest.length > 0) {
      rows.push([oid, rest.join(" ")]);
    }
  }
  return rows;
}

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

// The table that each relation TRANSACTION_QUERY listed before the migration
// belongs to, by oid. psql prints those rows before any output of the
// migration, so the first row for an oid is the probe's own. A later row for
// the same oid, which a SELECT in the migration can print, does not replace
// it.
function existingTablesByOid(psqlOutput) {
  const tableByOid = new Map();
  for (const [oid, table] of markedRows(psqlOutput, EXISTING_RELATION_MARKER)) {
    if (!tableByOid.has(oid)) {
      tableByOid.set(oid, table);
    }
  }
  return tableByOid;
}

// The tables of BOTH_ORDER_TABLES missing from the relations TRANSACTION_QUERY
// listed before the migration of `version`, other than one that this migration
// or a later one creates. bothOrderLockViolations counts a lock only on a
// listed relation, so it would pass a migration that locks one of these.
function unlistedBothOrderTables(stdout, version) {
  const listed = new Set(existingTablesByOid(stdout).values());
  const notCreatedYet = (table) =>
    version <= (BOTH_ORDER_TABLES_CREATED_BY.get(table) ?? LANE_BOUNDARY);
  return BOTH_ORDER_TABLES.filter((table) => !listed.has(table) && !notCreatedYet(table));
}

// The pairs of tables a migration's probe output shows it locks until it
// commits in a way a live request can deadlock against: two of `tables` with a
// conflicting lock, or another table that existed before the migration with a
// lock in OTHER_TABLE_LOCK_MODES beside one of `tables` with a conflicting
// lock, as [other, one of `tables`]. A lock on an index counts as a lock on
// its table. A relation the migration created is left out, because no live
// request can have locked it.
function bothOrderLockViolations(psqlOutput, tables = BOTH_ORDER_TABLES) {
  const tableByOid = existingTablesByOid(psqlOutput);
  const modesByTable = new Map();
  for (const [oid, mode] of markedRows(psqlOutput, HELD_LOCK_MARKER)) {
    const table = tableByOid.get(oid);
    if (table !== undefined) {
      modesByTable.set(table, (modesByTable.get(table) ?? new Set()).add(mode));
    }
  }
  const holds = (table, modes) =>
    [...(modesByTable.get(table) ?? [])].some((mode) => modes.has(mode));
  const locked = tables.filter((table) => holds(table, CONFLICTING_LOCK_MODES));
  const others = [...modesByTable.keys()]
    .filter((table) => !tables.includes(table) && holds(table, OTHER_TABLE_LOCK_MODES))
    .sort();
  return [
    ...tablePairs(tables).filter(
      ([left, right]) => locked.includes(left) && locked.includes(right),
    ),
    ...others.flatMap((other) => locked.map((table) => [other, table])),
  ];
}

// An argument that spans lines, such as a query or a migration, is shown in a
// failed command by its first line, so the error does not repeat its text.
function shownArgument(argument) {
  const [firstLine, ...rest] = argument.split("\n");
  return rest.length > 0 ? `${firstLine}...` : argument;
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
      `${command} ${args.map(shownArgument).join(" ")} failed${detail ? `: ${detail}` : ""}`,
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
      const version = BigInt(migration.version);
      const checkHeldLocks = version > LANE_BOUNDARY;
      const source = readFileSync(migration.source);
      // main() first runs validatePublicMigrationTrack, which rejects a
      // migration that is not valid UTF-8, whose bytes this would turn into
      // U+FFFD.
      const sql = source.toString("utf8");
      // psql sends a --command to the server as it is, so a psql meta-command
      // in the migration is a syntax error, as it is under supabase db push,
      // and cannot hide or print the probe's rows. psql runs a --command that
      // starts with a backslash as a meta-command instead.
      if (checkHeldLocks && sql.startsWith("\\")) {
        throw new Error(
          `${migration.track}:${migration.fileName} starts with a psql meta-command; a migration must be plain SQL`,
        );
      }
      if (checkHeldLocks && Buffer.byteLength(sql) > MAX_COMMAND_BYTES) {
        throw new Error(
          `${migration.track}:${migration.fileName} is larger than the ${MAX_COMMAND_BYTES} bytes one psql --command can carry; split it`,
        );
      }
      // With --single-transaction, psql runs its commands in order inside one
      // transaction: the id query, the migration, then the probe.
      const applied = commandResult(
        dockerCommand,
        [
          "exec",
          ...(checkHeldLocks ? [] : ["--interactive"]),
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
                "--command",
                sql,
                "--command",
                HELD_LOCK_QUERY,
              ]
            : []),
        ],
        checkHeldLocks ? { stdio: ["ignore", "pipe", "pipe"] } : { input: source },
      );
      if (checkHeldLocks) {
        const problem = heldLockProbeProblem(applied.stdout, applied.stderr);
        if (problem) {
          throw new Error(
            `${migration.track}:${migration.fileName} does not run in the one transaction psql opens for it, so its held locks cannot be checked (${problem}); remove its own BEGIN, COMMIT, END or ROLLBACK`,
          );
        }
        const unlisted = unlistedBothOrderTables(applied.stdout, version);
        if (unlisted.length > 0) {
          throw new Error(
            `${migration.track}:${migration.fileName} ran without ${unlisted.join(", ")} among the public tables before it, so its held locks cannot be checked`,
          );
        }
        const violations = bothOrderLockViolations(
          applied.stdout,
          FIRST_THREE_TABLES_ONLY.has(version)
            ? BOTH_ORDER_TABLES.slice(0, 3)
            : BOTH_ORDER_TABLES,
        );
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
  BOTH_ORDER_TABLES_CREATED_BY,
  FIRST_THREE_TABLES_ONLY,
  HELD_LOCK_QUERY,
  MAX_COMMAND_BYTES,
  OTHER_TABLE_LOCK_MODES,
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
  TRANSACTION_QUERY,
  bothOrderLockViolations,
  heldLockProbeProblem,
  resolveRunnableImage,
  runEmptyDatabaseMigrationTest,
  unlistedBothOrderTables,
  validateMigrationPlan,
};
