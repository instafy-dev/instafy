import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validatePublicMigrationTrack } from "./check-supabase-migrations.mjs";
import {
  BOTH_ORDER_TABLE_PAIRS,
  BOTH_ORDER_TABLES,
  HELD_LOCK_QUERY,
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
  TRANSACTION_QUERY,
  bothOrderLockViolations,
  heldLockProbeProblem,
  resolveRunnableImage,
  validateMigrationPlan,
} from "./test-supabase-migrations-empty-db.mjs";

test("empty-database tests use an immutable Supabase Postgres image", () => {
  assert.match(
    POSTGRES_IMAGE,
    /^public\.ecr\.aws\/supabase\/postgres@sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(REQUIRED_PUBLIC_RELATIONS, [
    "organizations",
    "projects",
    "runtime_providers",
    "user_credentials",
  ]);
});

test("the checked-in public track is a valid executable plan", () => {
  assert.doesNotThrow(() =>
    validateMigrationPlan(validatePublicMigrationTrack()),
  );
});

test("empty-database plans reject malformed and duplicate entries", () => {
  const valid = {
    fileName: "20260000000064_public.sql",
    source: "/tmp/public.sql",
    track: "public",
    version: 20260000000064n,
  };
  assert.throws(() => validateMigrationPlan([]), /at least one migration/u);
  assert.throws(
    () => validateMigrationPlan([{ ...valid, track: "unknown" }]),
    /invalid entry/u,
  );
  assert.throws(
    () => validateMigrationPlan([valid, { ...valid, fileName: "20260000000064_again.sql" }]),
    /duplicate version/u,
  );
});

test("direct migration runs explicitly acquire the pinned image", () => {
  const inspectCalls = [];
  const pullCalls = [];
  const image = resolveRunnableImage("fake-docker", {
    spawnCommand(command, args) {
      inspectCalls.push([command, ...args]);
      return { status: 1 };
    },
    pullImage(reference, options) {
      pullCalls.push({ reference, options });
      return reference;
    },
  });

  assert.equal(image, POSTGRES_IMAGE);
  assert.deepEqual(inspectCalls, [
    ["fake-docker", "image", "inspect", POSTGRES_IMAGE],
    [
      "fake-docker",
      "image",
      "inspect",
      `instafy-ci/supabase-postgres:sha256-${POSTGRES_IMAGE.split(":").at(-1)}`,
    ],
  ]);
  assert.deepEqual(pullCalls, [
    { reference: POSTGRES_IMAGE, options: { docker: "fake-docker" } },
  ]);
});

test("container startup cannot perform an implicit registry pull", () => {
  const source = readFileSync(
    new URL("./test-supabase-migrations-empty-db.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /"run",\s*"--pull",\s*"never"/u);
});

// psql prints the transaction id query's row, the migration's own command
// tags, then the probe rows indented under a header: the transaction id again
// and one row per lock. The rows below are what Postgres 17 reported for each
// case.
function psqlOutput({
  startId = "1066",
  endId = startId,
  tags = ["SET", "ALTER TABLE"],
  rows = [],
} = {}) {
  const probeRows = [
    ...(endId === null ? [] : [`instafy-migration-xact ${endId}`]),
    ...rows.map((row) => `instafy-migration-holds ${row}`),
  ];
  return [
    "          ?column?           ",
    "-----------------------------",
    ` instafy-migration-xact ${startId}`,
    "(1 row)",
    "",
    ...tags,
    "                            ?column?                             ",
    "-----------------------------------------------------------------",
    ...probeRows.map((row) => ` ${row}`),
    `(${probeRows.length} ${probeRows.length === 1 ? "row" : "rows"})`,
    "",
  ].join("\n");
}

function probeOutput(...rows) {
  return psqlOutput({ rows });
}

test("a migration may lock one table of a both-order pair and only read the other", () => {
  // The metering change as one file: its ALTER on the ledger and its foreign
  // keys to agent_jobs.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput(
        "agent_jobs AccessShareLock",
        "agent_jobs ShareRowExclusiveLock",
        "org_credit_ledger AccessExclusiveLock",
        "org_credit_ledger ShareLock",
      ),
    ),
    [["agent_jobs", "org_credit_ledger"]],
  );
  // The same change split in two, 20260929100000 and 20260929100100.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("org_credit_ledger AccessExclusiveLock", "org_credit_ledger ShareLock"),
    ),
    [],
  );
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("agent_jobs AccessShareLock", "agent_jobs ShareRowExclusiveLock"),
    ),
    [],
  );
  // A plain read and a COMMENT on agent_jobs beside the ALTER on the ledger.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("agent_jobs AccessShareLock", "org_credit_ledger AccessExclusiveLock"),
    ),
    [],
  );
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput(
        "agent_jobs ShareUpdateExclusiveLock",
        "org_credit_ledger AccessExclusiveLock",
      ),
    ),
    [],
  );
  assert.deepEqual(bothOrderLockViolations("CREATE FUNCTION\n(0 rows)\n"), []);
});

test("a migration that writes or row-locks one table of a pair and locks the other fails", () => {
  // Postgres takes these table locks even when the statement matches no rows,
  // as on the empty database. Raced against a seeded job, each of these
  // migrations deadlocked a live request that wrote the ledger and then
  // updated the job.
  for (const rows of [
    // update agent_jobs; alter table org_credit_ledger
    ["agent_jobs RowExclusiveLock", "org_credit_ledger AccessExclusiveLock"],
    // select from agent_jobs for update; alter table org_credit_ledger
    ["agent_jobs RowShareLock", "org_credit_ledger AccessExclusiveLock"],
    // update agent_jobs; insert into org_credit_ledger
    ["agent_jobs RowExclusiveLock", "org_credit_ledger RowExclusiveLock"],
  ]) {
    assert.deepEqual(
      bothOrderLockViolations(probeOutput(...rows)),
      [["agent_jobs", "org_credit_ledger"]],
      rows.join(", "),
    );
  }
});

test("the held-lock probe reports every table lock this transaction holds on the pair tables", () => {
  assert.match(HELD_LOCK_QUERY, /l\.pid = pg_backend_pid\(\)/u);
  assert.match(HELD_LOCK_QUERY, /l\.granted/u);
  assert.match(
    HELD_LOCK_QUERY,
    /c\.relname in \('agent_jobs', 'org_credit_ledger', 'org_credit_balances'\)/u,
  );
  assert.match(HELD_LOCK_QUERY, /c\.relname \|\| ' ' \|\| l\.mode/u);
  // The mode is judged in bothOrderLockViolations, so the probe keeps them all.
  assert.doesNotMatch(HELD_LOCK_QUERY, /l\.mode in/u);
  // Both queries print the id of the transaction they run in.
  assert.equal(
    TRANSACTION_QUERY,
    "select 'instafy-migration-xact ' || pg_current_xact_id();",
  );
  assert.ok(
    HELD_LOCK_QUERY.startsWith(
      "select 'instafy-migration-xact ' || pg_current_xact_id()\nunion all\n",
    ),
  );
});

test("a migration may not lock any two of agent_jobs, the ledger and the balances", () => {
  assert.deepEqual(BOTH_ORDER_TABLES, [
    "agent_jobs",
    "org_credit_ledger",
    "org_credit_balances",
  ]);
  assert.deepEqual(BOTH_ORDER_TABLE_PAIRS, [
    ["agent_jobs", "org_credit_ledger"],
    ["agent_jobs", "org_credit_balances"],
    ["org_credit_ledger", "org_credit_balances"],
  ]);
  // alter table org_credit_balances add column hyp_note text;
  // create table hyp_job_marks(job_id uuid references agent_jobs(id));
  // It passed the guard when only agent_jobs and the ledger were a pair, and
  // it deadlocked a completing job.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput(
        "agent_jobs AccessShareLock",
        "agent_jobs ShareRowExclusiveLock",
        "org_credit_balances AccessExclusiveLock",
      ),
    ),
    [["agent_jobs", "org_credit_balances"]],
  );
  for (const rows of [
    // update org_credit_balances; alter table org_credit_ledger
    ["org_credit_balances RowExclusiveLock", "org_credit_ledger AccessExclusiveLock"],
    // insert into org_credit_ledger; alter table org_credit_balances
    ["org_credit_balances AccessExclusiveLock", "org_credit_ledger RowExclusiveLock"],
  ]) {
    assert.deepEqual(
      bothOrderLockViolations(probeOutput(...rows)),
      [["org_credit_ledger", "org_credit_balances"]],
      rows.join(", "),
    );
  }
  // select from org_credit_balances; alter table org_credit_ledger
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("org_credit_balances AccessShareLock", "org_credit_ledger AccessExclusiveLock"),
    ),
    [],
  );
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput(
        "agent_jobs RowExclusiveLock",
        "org_credit_balances RowExclusiveLock",
        "org_credit_ledger RowExclusiveLock",
      ),
    ),
    BOTH_ORDER_TABLE_PAIRS,
  );
});

test("the probe reads the locks of the transaction the migration ran in", () => {
  // psql opens one transaction and runs the id query, the migration from
  // stdin, then the probe in it.
  const source = readFileSync(
    new URL("./test-supabase-migrations-empty-db.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /"--single-transaction",[^\]]*"--command",\s*TRANSACTION_QUERY,\s*"--file",\s*"-",\s*"--command",\s*HELD_LOCK_QUERY,/u,
  );
  // The migration ran as one transaction.
  assert.equal(
    heldLockProbeProblem(
      psqlOutput({ rows: ["org_credit_ledger AccessExclusiveLock"] }),
      "",
    ),
    null,
  );
  // create table hyp(job_id uuid references agent_jobs(id)); commit;
  // alter table org_credit_ledger add column hyp text;
  // The COMMIT ended psql's transaction, so the probe ran in a later one and
  // saw no lock, and psql warned when it sent its own COMMIT.
  assert.equal(
    heldLockProbeProblem(
      psqlOutput({
        startId: "1071",
        endId: "1073",
        tags: ["CREATE TABLE", "COMMIT", "ALTER TABLE"],
      }),
      "WARNING:  there is no transaction in progress\n",
    ),
    "transaction ids 1071, 1073",
  );
  // The same with COMMIT AND CHAIN, which draws no warning. The probe saw only
  // the ledger lock of the chained transaction.
  const chained = psqlOutput({
    startId: "1076",
    endId: "1077",
    tags: ["CREATE TABLE", "COMMIT", "ALTER TABLE"],
    rows: ["org_credit_ledger AccessExclusiveLock"],
  });
  assert.deepEqual(bothOrderLockViolations(chained), []);
  assert.equal(heldLockProbeProblem(chained, ""), "transaction ids 1076, 1077");
  // begin; ... commit; around the whole migration.
  assert.equal(
    heldLockProbeProblem(
      psqlOutput({
        startId: "1074",
        endId: "1075",
        tags: ["BEGIN", "CREATE TABLE", "ALTER TABLE", "COMMIT"],
      }),
      "psql:<stdin>:1: WARNING:  there is already a transaction in progress\n" +
        "WARNING:  there is no transaction in progress\n",
    ),
    "transaction ids 1074, 1075",
  );
  // A BEGIN with no COMMIT keeps one transaction, but psql warns about it.
  assert.equal(
    heldLockProbeProblem(
      psqlOutput({
        tags: ["BEGIN", "CREATE TABLE"],
        rows: ["agent_jobs AccessShareLock", "agent_jobs ShareRowExclusiveLock"],
      }),
      "psql:<stdin>:1: WARNING:  there is already a transaction in progress\n",
    ),
    'psql warned "there is already a transaction in progress"',
  );
  // No proof: the probe printed no transaction id, or nothing ran at all.
  assert.equal(
    heldLockProbeProblem(psqlOutput({ endId: null }), ""),
    "transaction ids 1066",
  );
  assert.equal(heldLockProbeProblem("CREATE TABLE\n", ""), "transaction ids missing");
});
