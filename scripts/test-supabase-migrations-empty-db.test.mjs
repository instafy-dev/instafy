import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validatePublicMigrationTrack } from "./check-supabase-migrations.mjs";
import {
  BOTH_ORDER_TABLE_PAIRS,
  HELD_LOCK_QUERY,
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
  bothOrderLockViolations,
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

// psql prints the probe rows indented under a header, after the migration's own
// command tags. The rows below are what Postgres 17 reported for each case.
function probeOutput(...rows) {
  return [
    "SET",
    "ALTER TABLE",
    "                    ?column?",
    "--------------------------------------------------------------",
    ...rows.map((row) => ` instafy-migration-holds ${row}`),
    `(${rows.length} ${rows.length === 1 ? "row" : "rows"})`,
    "",
  ].join("\n");
}

test("a migration may lock one table of a both-order pair and only read the other", () => {
  assert.deepEqual(BOTH_ORDER_TABLE_PAIRS, [["agent_jobs", "org_credit_ledger"]]);
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
  assert.match(HELD_LOCK_QUERY, /c\.relname in \('agent_jobs', 'org_credit_ledger'\)/u);
  assert.match(HELD_LOCK_QUERY, /c\.relname \|\| ' ' \|\| l\.mode/u);
  // The mode is judged in bothOrderLockViolations, so the probe keeps them all.
  assert.doesNotMatch(HELD_LOCK_QUERY, /l\.mode in/u);
});
