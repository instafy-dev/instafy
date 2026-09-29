import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LANE_BOUNDARY,
  validatePublicMigrationTrack,
} from "./check-supabase-migrations.mjs";
import {
  BOTH_ORDER_TABLE_PAIRS,
  BOTH_ORDER_TABLES,
  BOTH_ORDER_TABLES_CREATED_BY,
  FIRST_THREE_TABLES_ONLY,
  HELD_LOCK_QUERY,
  MAX_COMMAND_BYTES,
  OTHER_TABLE_LOCK_MODES,
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
  REVIEWED_LOCK_EXCEPTIONS,
  TRANSACTION_QUERY,
  bothOrderLockViolations,
  heldLockProbeProblem,
  heldLockTimeout,
  mentionsLockTimeoutOnce,
  resolveRunnableImage,
  runEmptyDatabaseMigrationTest,
  setsLockTimeoutFirst,
  unlistedBothOrderTables,
  validateMigrationPlan,
  validateReviewedLockExceptions,
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

// The public relations that exist before a synthetic migration, as the id
// query lists them: the relation's oid and the table it belongs to. 16408 is
// an index on agent_jobs.
const EXISTING_RELATIONS = [
  ["16401", "agent_jobs"],
  ["16402", "org_credit_ledger"],
  ["16403", "org_credit_balances"],
  ["16404", "organizations"],
  ["16405", "projects"],
  ["16406", "org_subscriptions"],
  ["16407", "runs"],
  ["16408", "agent_jobs"],
  ["16409", "prompts"],
  ["16410", "conversations"],
  ["16411", "conversation_messages"],
  ["16412", "runtimes"],
  ["16413", "notification_events"],
  ["16414", "notification_recipients"],
  ["16415", "notification_delivery_jobs"],
  ["16416", "agent_job_inputs"],
  ["16417", "activity_events"],
  ["16418", "runtime_events"],
  ["16419", "conversation_participants"],
  ["16420", "runtime_leases"],
  ["16421", "automations"],
  ["16422", "bug_reports"],
  ["16423", "bug_report_messages"],
  ["16424", "origin_instances"],
  ["16425", "notification_delivery_attempts"],
  ["16426", "user_agents"],
];

// A probe row names a relation by its oid. A test names it by table, or by oid
// for an index; a table missing from EXISTING_RELATIONS is one the migration
// created, with an oid the id query did not list.
function lockRow(row) {
  const [relation, mode] = row.split(" ");
  const existing = EXISTING_RELATIONS.find(([, table]) => table === relation);
  const oid = /^[0-9]+$/u.test(relation) ? relation : existing?.[0] ?? "17001";
  return `${oid} ${mode}`;
}

function aligned(rows) {
  return [
    "                            ?column?                             ",
    "-----------------------------------------------------------------",
    ...rows.map((row) => ` ${row}`),
    `(${rows.length} ${rows.length === 1 ? "row" : "rows"})`,
    "",
  ];
}

// psql prints the rows of the id query, the migration's own command tags,
// then the probe rows, each query's rows indented under a header. The id
// query prints the transaction id and one row per existing relation; the
// probe prints the transaction id again, the lock_timeout in milliseconds and
// one row per lock. The rows below are what Postgres 17 reported for each
// case.
function psqlOutput({
  startId = "1066",
  endId = startId,
  existing = EXISTING_RELATIONS,
  tags = ["SET", "ALTER TABLE"],
  lockTimeout = "5000",
  rows = [],
} = {}) {
  return [
    ...aligned([
      ...(startId === null ? [] : [`instafy-migration-xact ${startId}`]),
      ...existing.map(([oid, table]) => `instafy-migration-existing ${oid} ${table}`),
    ]),
    ...tags,
    ...aligned([
      ...(endId === null ? [] : [`instafy-migration-xact ${endId}`]),
      ...(lockTimeout === null ? [] : [`instafy-migration-lock-timeout ${lockTimeout}`]),
      ...rows.map((row) => `instafy-migration-holds ${lockRow(row)}`),
    ]),
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

test("the held-lock probe reports every relation lock this transaction holds on a public relation", () => {
  assert.match(HELD_LOCK_QUERY, /l\.pid = pg_backend_pid\(\)/u);
  assert.match(HELD_LOCK_QUERY, /l\.granted/u);
  assert.match(HELD_LOCK_QUERY, /l\.locktype = 'relation'/u);
  // Every public relation, and one the migration dropped, whose pg_class row
  // this transaction no longer sees.
  assert.match(
    HELD_LOCK_QUERY,
    /left join pg_class c on c\.oid = l\.relation\n[^;]*\(c\.oid is null or c\.relnamespace = 'public'::regnamespace\);/u,
  );
  assert.match(HELD_LOCK_QUERY, /'instafy-migration-holds ' \|\| l\.relation \|\| ' ' \|\| l\.mode/u);
  // The tables and modes are judged in bothOrderLockViolations, so the probe
  // keeps them all.
  assert.doesNotMatch(HELD_LOCK_QUERY, /relname in|l\.mode in/u);
  // It also reads the lock_timeout, in milliseconds, that the migration left
  // in force.
  assert.match(
    HELD_LOCK_QUERY,
    /\nunion all\nselect 'instafy-migration-lock-timeout ' \|\| setting from pg_settings where name = 'lock_timeout'\nunion all\n/u,
  );
  assert.equal(heldLockTimeout(psqlOutput({ lockTimeout: "5000" })), 5000);
  assert.equal(heldLockTimeout(psqlOutput({ lockTimeout: "0" })), 0);
  // No row, or a second one that the migration printed, cannot be read.
  assert.equal(heldLockTimeout(psqlOutput({ lockTimeout: null })), null);
  assert.equal(
    heldLockTimeout(
      psqlOutput({ lockTimeout: "0", tags: ["SET", ...aligned(["instafy-migration-lock-timeout 5000"])] }),
    ),
    null,
  );
  assert.equal(heldLockTimeout(psqlOutput({ lockTimeout: "5s" })), null);
  // The id query lists every public relation before the migration, with the
  // table an index is on.
  assert.match(
    TRANSACTION_QUERY,
    /'instafy-migration-existing ' \|\| c\.oid \|\| ' ' \|\| coalesce\(t\.relname, c\.relname\)\nfrom pg_class c\nleft join pg_index i on i\.indexrelid = c\.oid\nleft join pg_class t on t\.oid = i\.indrelid\nwhere c\.relnamespace = 'public'::regnamespace;/u,
  );
  // Both queries resolve every name in pg_catalog, so that a view such as
  // create temporary view pg_locks as select * from pg_catalog.pg_locks where false;
  // cannot empty the probe, and print the id of the transaction they run in.
  for (const query of [TRANSACTION_QUERY, HELD_LOCK_QUERY]) {
    assert.ok(
      query.startsWith(
        "set local search_path = pg_catalog, pg_temp;\nselect 'instafy-migration-xact ' || pg_current_xact_id()\nunion all\n",
      ),
    );
  }
  // The migration runs with the session's own search_path.
  assert.ok(TRANSACTION_QUERY.endsWith(";\nset local search_path to default;\n"));
  assert.equal(HELD_LOCK_QUERY.match(/search_path/gu).length, 1);
});

test("a migration may not hold a blocking lock on another existing table beside one of the list", () => {
  assert.deepEqual(
    [...OTHER_TABLE_LOCK_MODES].sort(),
    ["AccessExclusiveLock", "ExclusiveLock", "RowExclusiveLock", "RowShareLock"],
  );
  for (const [rows, expected] of [
    // alter table organizations add column x text;
    // alter table org_credit_balances add column y text;
    // Raced against a seeded org, it deadlocked a refill: the balance upsert,
    // its FOR UPDATE, then a ledger insert whose foreign-key check row-locks
    // the organization.
    [
      ["organizations AccessExclusiveLock", "org_credit_balances AccessExclusiveLock"],
      [["organizations", "org_credit_balances"]],
    ],
    // alter table projects add column x text;
    // alter table agent_jobs add column y text;
    // It deadlocked a completion: update agent_jobs, then a read of projects.
    [
      ["projects AccessExclusiveLock", "agent_jobs AccessExclusiveLock"],
      [["projects", "agent_jobs"]],
    ],
    // alter table org_subscriptions add column x text;
    // alter table org_credit_balances add column y text;
    // It deadlocked credit status, which reads org_subscriptions after the
    // refill's balance lock.
    [
      ["org_subscriptions AccessExclusiveLock", "org_credit_balances AccessExclusiveLock"],
      [["org_subscriptions", "org_credit_balances"]],
    ],
    // lock table organizations in exclusive mode;
    // alter table org_credit_balances add column y text;
    // EXCLUSIVE allows the refill's reads but not its foreign-key row lock,
    // and it deadlocked the refill too.
    [
      ["organizations ExclusiveLock", "org_credit_balances AccessExclusiveLock"],
      [["organizations", "org_credit_balances"]],
    ],
    // update projects set name = name where false;
    // alter table agent_jobs add column y text;
    // The update's row locks block a request that locks the same rows.
    [
      ["projects RowExclusiveLock", "agent_jobs AccessExclusiveLock"],
      [["projects", "agent_jobs"]],
    ],
    // select from projects for update; update agent_jobs
    [
      ["projects RowShareLock", "agent_jobs RowExclusiveLock"],
      [["projects", "agent_jobs"]],
    ],
    // Each other table pairs with each table of the list it locks, after the
    // pairs within the list.
    [
      [
        "projects RowExclusiveLock",
        "org_subscriptions AccessExclusiveLock",
        "agent_jobs RowExclusiveLock",
        "org_credit_ledger RowExclusiveLock",
      ],
      [
        ["agent_jobs", "org_credit_ledger"],
        ["org_subscriptions", "agent_jobs"],
        ["org_subscriptions", "org_credit_ledger"],
        ["projects", "agent_jobs"],
        ["projects", "org_credit_ledger"],
      ],
    ],
  ]) {
    assert.deepEqual(bothOrderLockViolations(probeOutput(...rows)), expected, rows.join(", "));
  }
});

test("a migration may read, index or reference another table beside one of the list", () => {
  for (const rows of [
    // 20260929100100 as the empty database reports it: foreign keys to
    // organizations, projects and agent_jobs from the tables it creates.
    [
      "organizations AccessShareLock",
      "organizations ShareRowExclusiveLock",
      "projects AccessShareLock",
      "projects ShareRowExclusiveLock",
      "agent_jobs AccessShareLock",
      "agent_jobs ShareRowExclusiveLock",
      "ai_usage_jobs AccessExclusiveLock",
      "ai_usage_jobs ShareLock",
    ],
    // create table hyp (org_id uuid references organizations(id));
    // alter table org_credit_balances add column y text;
    // SHARE ROW EXCLUSIVE blocks only a write to organizations. Raced the same
    // way, the refill committed.
    ["organizations ShareRowExclusiveLock", "org_credit_balances AccessExclusiveLock"],
    // create table hyp (project_id uuid references projects(id));
    // alter table agent_jobs add column y text;
    // The completion committed.
    ["projects ShareRowExclusiveLock", "agent_jobs AccessExclusiveLock"],
    // create index on organizations; alter table org_credit_balances
    ["organizations ShareLock", "org_credit_balances AccessExclusiveLock"],
    // A read of projects and a COMMENT on runs beside an ALTER of agent_jobs.
    [
      "projects AccessShareLock",
      "runs ShareUpdateExclusiveLock",
      "agent_jobs AccessExclusiveLock",
    ],
    // alter table projects; alter table organizations. Neither is in the
    // list.
    ["projects AccessExclusiveLock", "organizations AccessExclusiveLock"],
    // alter table projects beside a read of agent_jobs.
    ["projects AccessExclusiveLock", "agent_jobs AccessShareLock"],
  ]) {
    assert.deepEqual(bothOrderLockViolations(probeOutput(...rows)), [], rows.join(", "));
  }
});

test("only relations that existed before the migration count, an index as its table", () => {
  // create table hyp_new (id uuid primary key);
  // alter table hyp_new add column z text;
  // alter table agent_jobs add column y text;
  // No live request can lock a table before the migration that creates it
  // commits.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("hyp_new AccessExclusiveLock", "agent_jobs AccessExclusiveLock"),
    ),
    [],
  );
  // The same table, listed as existing, does count.
  assert.deepEqual(
    bothOrderLockViolations(
      psqlOutput({
        existing: [...EXISTING_RELATIONS, ["17001", "hyp_new"]],
        rows: ["hyp_new AccessExclusiveLock", "agent_jobs AccessExclusiveLock"],
      }),
    ),
    [["hyp_new", "agent_jobs"]],
  );
  // 16408 is an index on agent_jobs: a rewrite of agent_jobs locks it, and
  // that is a lock on agent_jobs, not on another table.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("agent_jobs AccessExclusiveLock", "16408 AccessExclusiveLock"),
    ),
    [],
  );
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("16408 AccessExclusiveLock", "org_credit_ledger RowExclusiveLock"),
    ),
    [["agent_jobs", "org_credit_ledger"]],
  );
  // The tables of the list must be listed before the migration, or their
  // locks would not count.
  assert.deepEqual(unlistedBothOrderTables(psqlOutput(), 20260929100200n), []);
  assert.deepEqual(
    unlistedBothOrderTables(
      psqlOutput({
        existing: EXISTING_RELATIONS.filter(([, table]) => table !== "org_credit_ledger"),
      }),
      20260000000064n,
    ),
    ["org_credit_ledger"],
  );
  // A table of the list that a migration after the lane boundary created is
  // not listed before that migration, or before an earlier one, and is listed
  // before every later one.
  const withoutLaterTables = psqlOutput({
    existing: EXISTING_RELATIONS.filter(
      ([, table]) => !BOTH_ORDER_TABLES_CREATED_BY.has(table),
    ),
  });
  for (const version of [20260000000064n, 20260816213316n, 20260816213318n]) {
    assert.deepEqual(unlistedBothOrderTables(withoutLaterTables, version), [], `${version}`);
  }
  assert.deepEqual(unlistedBothOrderTables(withoutLaterTables, 20260816213320n), [
    "agent_job_inputs",
  ]);
  assert.deepEqual(unlistedBothOrderTables(withoutLaterTables, 20260905120000n), [
    "agent_job_inputs",
    "activity_events",
  ]);
  assert.deepEqual(unlistedBothOrderTables(withoutLaterTables, 20260905120002n), [
    "agent_job_inputs",
    "activity_events",
    "bug_report_messages",
  ]);
  assert.deepEqual(unlistedBothOrderTables(withoutLaterTables, 20260906120000n), [
    "agent_job_inputs",
    "activity_events",
    "bug_report_messages",
  ]);
  assert.deepEqual(unlistedBothOrderTables(withoutLaterTables, 20260906120002n), [
    "notification_events",
    "notification_recipients",
    "notification_delivery_jobs",
    "agent_job_inputs",
    "activity_events",
    "bug_report_messages",
    "notification_delivery_attempts",
  ]);
});

test("each table of the list is expected from the migration after the one that created it", () => {
  // The checked-in migration that first creates each table: one at or before
  // the lane boundary, or the one BOTH_ORDER_TABLES_CREATED_BY names.
  const track = validatePublicMigrationTrack();
  for (const table of BOTH_ORDER_TABLES) {
    const creates = new RegExp(
      `^create table (if not exists )?(public\\.)?${table}\\s*\\(`,
      "imu",
    );
    const creator = track.find(({ source }) => creates.test(readFileSync(source, "utf8")));
    assert.ok(creator, table);
    if (BOTH_ORDER_TABLES_CREATED_BY.has(table)) {
      assert.equal(creator.version, BOTH_ORDER_TABLES_CREATED_BY.get(table), table);
    } else {
      assert.ok(creator.version <= LANE_BOUNDARY, `${table} ${creator.version}`);
    }
  }
  assert.deepEqual(
    [...BOTH_ORDER_TABLES_CREATED_BY.keys()].filter((table) => !BOTH_ORDER_TABLES.includes(table)),
    [],
  );
});

test("a row the migration prints cannot rename a relation the id query listed", () => {
  // alter table agent_jobs add column y text;
  // alter table org_credit_ledger add column z text;
  // select 'instafy-migration-existing ' || 'public.agent_jobs'::regclass::oid || ' hyp_a'
  // union all select 'instafy-migration-existing ' || 'public.org_credit_ledger'::regclass::oid || ' hyp_b';
  // It passed when the last row for an oid named its table.
  const forged = aligned([
    "instafy-migration-existing 16401 hyp_a",
    "instafy-migration-existing 16402 hyp_b",
  ]);
  assert.deepEqual(
    bothOrderLockViolations(
      psqlOutput({
        tags: ["SET", "ALTER TABLE", "ALTER TABLE", ...forged],
        rows: ["agent_jobs AccessExclusiveLock", "org_credit_ledger AccessExclusiveLock"],
      }),
    ),
    [["agent_jobs", "org_credit_ledger"]],
  );
  // alter table organizations add column x text;
  // alter table org_credit_balances add column y text;
  // then a row that names the balances' oid organizations.
  assert.deepEqual(
    bothOrderLockViolations(
      psqlOutput({
        tags: ["ALTER TABLE", "ALTER TABLE", ...aligned(["instafy-migration-existing 16403 organizations"])],
        rows: ["organizations AccessExclusiveLock", "org_credit_balances AccessExclusiveLock"],
      }),
    ),
    [["organizations", "org_credit_balances"]],
  );
});

test("a migration may not lock any two of agent_jobs, the ledger and the balances", () => {
  assert.deepEqual(BOTH_ORDER_TABLES.slice(0, 3), [
    "agent_jobs",
    "org_credit_ledger",
    "org_credit_balances",
  ]);
  assert.deepEqual(BOTH_ORDER_TABLE_PAIRS.slice(0, 3), [
    ["agent_jobs", "org_credit_ledger"],
    ["agent_jobs", "org_credit_balances"],
    ["agent_jobs", "runs"],
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
    [
      ["agent_jobs", "org_credit_ledger"],
      ["agent_jobs", "org_credit_balances"],
      ["org_credit_ledger", "org_credit_balances"],
    ],
  );
});

test("runs, prompts and the conversation tables pair with the other tables of the list", () => {
  assert.deepEqual(BOTH_ORDER_TABLES.slice(0, 7), [
    "agent_jobs",
    "org_credit_ledger",
    "org_credit_balances",
    "runs",
    "prompts",
    "conversations",
    "conversation_messages",
  ]);
  for (const [rows, expected] of [
    // alter table agent_jobs add column hyp_run uuid references runs(id);
    // Dispatch inserts the run and then the job, and cancel and completion
    // update the job and then the run, so no lock order is safe. Raced
    // against dispatch, it deadlocked.
    [
      ["runs AccessShareLock", "runs ShareRowExclusiveLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runs"]],
    ],
    // create table hyp_j1 (run_id uuid references runs(id));
    // alter table agent_jobs add column y text;
    // The runs-first order deadlocked a cancel.
    [
      ["hyp_j1 AccessExclusiveLock", "runs ShareRowExclusiveLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runs"]],
    ],
    // create index on agent_jobs(created_at); create index on runs(created_at);
    [["agent_jobs ShareLock", "runs ShareLock"], [["agent_jobs", "runs"]]],
    // create index on prompts(created_at);
    // alter table org_credit_ledger add column y text;
    // Dispatch inserts the prompt before the ledger, and deferred billing
    // writes the ledger before the prompt.
    [
      ["prompts ShareLock", "org_credit_ledger AccessExclusiveLock"],
      [["org_credit_ledger", "prompts"]],
    ],
    // create index on conversation_messages(created_at);
    // alter table agent_jobs add column y text;
    // Dispatch inserts the user's message before the job, and completion
    // updates the job before it inserts the agent's message.
    [
      ["conversation_messages ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "conversation_messages"]],
    ],
    // create table hyp_c (conversation_id uuid references conversations(id));
    // alter table org_credit_ledger add column y text;
    [
      ["conversations ShareRowExclusiveLock", "org_credit_ledger AccessExclusiveLock"],
      [["org_credit_ledger", "conversations"]],
    ],
  ]) {
    assert.deepEqual(bothOrderLockViolations(probeOutput(...rows)), expected, rows.join(", "));
  }
  // Against the first three tables alone, runs is another table, where SHARE
  // ROW EXCLUSIVE is allowed.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("runs ShareRowExclusiveLock", "agent_jobs AccessExclusiveLock"),
      BOTH_ORDER_TABLES.slice(0, 3),
    ),
    [],
  );
});

test("runtimes, the notification tables, job inputs, activity and runtime events pair with the list", () => {
  assert.deepEqual(BOTH_ORDER_TABLES.slice(7, 14), [
    "runtimes",
    "notification_events",
    "notification_recipients",
    "notification_delivery_jobs",
    "agent_job_inputs",
    "activity_events",
    "runtime_events",
  ]);
  // Each migration below holds only SHARE or SHARE ROW EXCLUSIVE on the first
  // table, which the rule for other tables allowed. Raced in both orders
  // against a live request that writes the two tables in the other order,
  // each one deadlocked, and in the request's own order each committed.
  for (const [rows, expected] of [
    // create index on runtimes (created_at);
    // alter table agent_jobs add column y text;
    // Dispatch, lease and heartbeat write runtimes before agent_jobs, and a
    // runtime stop requeues agent_jobs before it updates runtimes.
    [
      ["runtimes ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runtimes"]],
    ],
    // create table hyp_r (runtime_id uuid references runtimes(id));
    // alter table agent_jobs add column y text;
    [
      ["hyp_r AccessExclusiveLock", "runtimes ShareRowExclusiveLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runtimes"]],
    ],
    // create index on notification_events (occurred_at), and the same on the
    // other two; alter table agent_jobs add column y text;
    // Dispatch inserts the user's message, whose trigger writes all three,
    // before agent_jobs. Completion updates agent_jobs before its reply's
    // trigger and the deferred run trigger write them.
    [
      ["notification_events ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "notification_events"]],
    ],
    [
      ["notification_recipients ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "notification_recipients"]],
    ],
    [
      ["notification_delivery_jobs ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "notification_delivery_jobs"]],
    ],
    // create index on agent_job_inputs (created_at);
    // alter table conversation_messages add column y text;
    // A steer inserts the message before its input, and an acknowledgement
    // updates the input before the message.
    [
      ["agent_job_inputs ShareLock", "conversation_messages AccessExclusiveLock"],
      [["conversation_messages", "agent_job_inputs"]],
    ],
    // create index on activity_events (created_at);
    // alter table agent_jobs add column y text;
    // Dispatch records a new conversation before it inserts the job, and
    // completion updates the job before it records the finished run.
    [
      ["activity_events ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "activity_events"]],
    ],
    // create index on runtime_events (created_at);
    // alter table agent_jobs add column y text;
    // Dispatch records a new runtime's event before it inserts the job, and
    // completion and a runtime stop update the job before their events.
    [
      ["runtime_events ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runtime_events"]],
    ],
  ]) {
    assert.deepEqual(bothOrderLockViolations(probeOutput(...rows)), expected, rows.join(", "));
  }
  // Against the first three tables alone, runtimes is another table, where
  // SHARE is allowed.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("runtimes ShareLock", "agent_jobs AccessExclusiveLock"),
      BOTH_ORDER_TABLES.slice(0, 3),
    ),
    [],
  );
});

test("participants, leases, automations, support reports, origins, attempts and agents pair with the list", () => {
  assert.deepEqual(BOTH_ORDER_TABLES.slice(14), [
    "conversation_participants",
    "runtime_leases",
    "automations",
    "bug_reports",
    "bug_report_messages",
    "origin_instances",
    "notification_delivery_attempts",
    "user_agents",
  ]);
  assert.equal(BOTH_ORDER_TABLE_PAIRS.length, 231);
  // Each migration below holds only SHARE or SHARE ROW EXCLUSIVE on the first
  // table, which the rule for other tables allowed. Raced in both orders
  // against a live request that writes the two tables in the other order,
  // each one deadlocked, and in the request's own order each committed.
  for (const [rows, expected] of [
    // create index on conversation_participants (created_at);
    // alter table agent_jobs add column y text;
    // Dispatch adds the sender before it inserts the job, and a steer locks
    // the job before it adds the sender.
    [
      ["conversation_participants ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "conversation_participants"]],
    ],
    // The same beside conversation_messages: dispatch in a new conversation
    // adds its owner before the message, and every dispatch adds the sender
    // after it.
    [
      ["conversation_participants ShareLock", "conversation_messages AccessExclusiveLock"],
      [["conversation_messages", "conversation_participants"]],
    ],
    // create index on runtime_leases (requested_at);
    // alter table agent_jobs add column y text;
    // A provider-managed stop quarantines the lease before it requeues the
    // jobs, and its final transaction updates the jobs before it releases the
    // lease.
    [
      ["runtime_leases ShareLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runtime_leases"]],
    ],
    // create table hyp_l (lease_id uuid references runtime_leases(id));
    // alter table agent_jobs add column y text;
    [
      ["hyp_l AccessExclusiveLock", "runtime_leases ShareRowExclusiveLock", "agent_jobs AccessExclusiveLock"],
      [["agent_jobs", "runtime_leases"]],
    ],
    // create index on automations (created_at);
    // alter table conversations add column y text;
    // Creating or editing an automation writes its conversation first, and a
    // launch failure updates the automation before it posts its notice.
    [
      ["automations ShareLock", "conversations AccessExclusiveLock"],
      [["conversations", "automations"]],
    ],
    // create index on bug_reports (created_at);
    // alter table notification_recipients add column y text;
    // A support acknowledgement updates the report first, and marking its
    // notification read updates the recipient first.
    [
      ["bug_reports ShareLock", "notification_recipients AccessExclusiveLock"],
      [["notification_recipients", "bug_reports"]],
    ],
    // create index on bug_report_messages (created_at);
    // create index on bug_reports (created_at);
    // A reply inserts its message before it updates the report, and a status
    // change updates the report before its system message. Both first lock
    // the report with FOR UPDATE, which an ALTER would wait on from the
    // start, so this race used two indexes.
    [
      ["bug_report_messages ShareLock", "bug_reports ShareLock"],
      [["bug_reports", "bug_report_messages"]],
    ],
    // create index on origin_instances (created_at);
    // alter table runtime_events add column y text;
    // Ensuring a new runtime records its event before its origin instance,
    // and a stop releases the origin instances before its event.
    [
      ["origin_instances ShareLock", "runtime_events AccessExclusiveLock"],
      [["runtime_events", "origin_instances"]],
    ],
    // create index on notification_delivery_attempts (attempt_no);
    // create index on notification_delivery_jobs (next_attempt_at);
    // A delivery result updates the job before its attempt, and leasing a job
    // whose lease expired updates the attempt first.
    [
      ["notification_delivery_attempts ShareLock", "notification_delivery_jobs ShareLock"],
      [["notification_delivery_jobs", "notification_delivery_attempts"]],
    ],
    // create index on user_agents (created_at);
    // create index on conversations (created_at);
    // A user's first dispatch creates their agent after a new conversation,
    // or before the message updates an existing one.
    [
      ["user_agents ShareLock", "conversations ShareLock"],
      [["conversations", "user_agents"]],
    ],
    // create index on user_agents (created_at);
    // alter table conversation_participants add column y text;
    [
      ["user_agents ShareLock", "conversation_participants AccessExclusiveLock"],
      [["conversation_participants", "user_agents"]],
    ],
  ]) {
    assert.deepEqual(bothOrderLockViolations(probeOutput(...rows)), expected, rows.join(", "));
  }
  // Against the first three tables alone, these are other tables, where SHARE
  // is allowed.
  assert.deepEqual(
    bothOrderLockViolations(
      probeOutput("runtime_leases ShareLock", "agent_jobs AccessExclusiveLock"),
      BOTH_ORDER_TABLES.slice(0, 3),
    ),
    [],
  );
});

test("migrations on main that only the longer list rejects are checked against the first three", () => {
  // Each holds a foreign key or more on runs, conversations or
  // conversation_messages beside a conflicting lock on another table of the
  // list, or beside an ALTER of another existing table. They merged before the
  // list grew, and history is append-only.
  assert.deepEqual([...FIRST_THREE_TABLES_ONLY].sort(), [
    20260816213316n,
    20260816213318n,
    20260906120000n,
  ]);
  const track = validatePublicMigrationTrack().map(({ version }) => version);
  for (const version of FIRST_THREE_TABLES_ONLY) {
    assert.ok(track.includes(version), `${version}`);
  }
});

test("the probe reads the locks of the transaction the migration ran in", () => {
  // psql opens one transaction and runs the id query, the migration, then the
  // probe in it.
  const source = readFileSync(
    new URL("./test-supabase-migrations-empty-db.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /"--single-transaction",[^\]]*"--command",\s*TRANSACTION_QUERY,\s*"--command",\s*sql,\s*"--command",\s*HELD_LOCK_QUERY,/u,
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

// A stand-in for docker that the runner drives through a whole run: it
// reports the container healthy, keeps the arguments and the input of the
// migration's psql, and answers it with the output and the exit status a test
// wrote beside it.
function fakeDocker(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "instafy-fake-docker-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const command = path.join(directory, "docker");
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      'here=$(dirname "$0")',
      'case "$1 $2" in',
      '  "inspect --format") echo healthy ;;',
      '  "exec "*)',
      '    case "$*" in',
      "      *pg_isready*) ;;",
      "      *--single-transaction*)",
      '        rm -f "$here"/arg.*',
      "        n=0",
      '        for arg in "$@"; do n=$((n + 1)); printf %s "$arg" >"$here/arg.$n"; done',
      '        cat >"$here/input"',
      '        cat "$here/stdout"',
      '        cat "$here/stderr" >&2',
      '        exit "$(cat "$here/status")" ;;',
      "      *) echo true ;;",
      "    esac ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  const run = (
    stdout,
    stderr = "",
    {
      version = 20260000000064n,
      sql = "alter table public.org_credit_ledger add column hyp text;\n",
      status = 0,
      exceptions = new Map(),
    } = {},
  ) => {
    const fileName = `${version}_public.sql`;
    const source = path.join(directory, fileName);
    writeFileSync(source, sql);
    writeFileSync(path.join(directory, "stdout"), stdout);
    writeFileSync(path.join(directory, "stderr"), stderr);
    writeFileSync(path.join(directory, "status"), `${status}\n`);
    runEmptyDatabaseMigrationTest({
      label: "fake",
      dockerCommand: command,
      migrations: [{ fileName, source, track: "public", version }],
      reviewedLockExceptions: exceptions,
    });
  };
  // The arguments and the input of the last migration's psql.
  run.psql = () => {
    const args = [];
    for (let n = 1; existsSync(path.join(directory, `arg.${n}`)); n += 1) {
      args.push(readFileSync(path.join(directory, `arg.${n}`), "utf8"));
    }
    return { args, input: readFileSync(path.join(directory, "input"), "utf8") };
  };
  return run;
}

test("the runner fails a migration whose locks it cannot read in the migration's transaction", (t) => {
  t.mock.method(console, "log", () => {});
  const run = fakeDocker(t);
  const rows = ["org_credit_ledger AccessExclusiveLock"];
  assert.doesNotThrow(() => run(psqlOutput({ rows })));
  const unchecked = (problem) =>
    new RegExp(
      `^Error: public:20260000000064_public\\.sql does not run in the one transaction psql opens for it, so its held locks cannot be checked \\(${problem}\\); remove its own BEGIN, COMMIT, END or ROLLBACK$`,
      "u",
    );
  // The probe printed no transaction id, the id query printed none, or
  // neither did.
  assert.throws(() => run(psqlOutput({ endId: null, rows })), unchecked("transaction ids 1066"));
  assert.throws(
    () => run(psqlOutput({ startId: null, endId: "1066", rows })),
    unchecked("transaction ids 1066"),
  );
  assert.throws(
    () => run(psqlOutput({ startId: null, endId: null, rows })),
    unchecked("transaction ids missing"),
  );
  // The two ids differ.
  assert.throws(
    () => run(psqlOutput({ startId: "1071", endId: "1073", rows })),
    unchecked("transaction ids 1071, 1073"),
  );
  // The ids match, but psql warned about each of its transaction commands.
  for (const warning of [
    "there is already a transaction in progress",
    "there is no transaction in progress",
  ]) {
    assert.throws(
      () => run(psqlOutput({ rows }), `psql:<stdin>:1: WARNING:  ${warning}\n`),
      unchecked(`psql warned "${warning}"`),
    );
  }
  // The tables of the list were not all listed before the migration.
  assert.throws(
    () =>
      run(
        psqlOutput({
          existing: EXISTING_RELATIONS.filter(([, table]) => table !== "org_credit_ledger"),
          rows,
        }),
      ),
    /^Error: public:20260000000064_public\.sql ran without org_credit_ledger among the public tables before it, so its held locks cannot be checked$/u,
  );
  // 20260906120000 creates the notification tables, so they are not listed
  // before it, but they are before every later migration.
  const withoutNotifications = EXISTING_RELATIONS.filter(
    ([, table]) => !table.startsWith("notification_"),
  );
  assert.doesNotThrow(() =>
    run(psqlOutput({ existing: withoutNotifications, rows }), "", { version: 20260906120000n }),
  );
  assert.throws(
    () => run(psqlOutput({ existing: withoutNotifications, rows }), "", { version: 20260906120002n }),
    /^Error: public:20260906120002_public\.sql ran without notification_events, notification_recipients, notification_delivery_jobs, notification_delivery_attempts among the public tables before it, so its held locks cannot be checked$/u,
  );
  // The locks were read and are a violation.
  assert.throws(
    () => run(psqlOutput({ rows: ["projects AccessExclusiveLock", "agent_jobs AccessExclusiveLock"] })),
    /^Error: public:20260000000064_public\.sql writes or locks both projects and agent_jobs until it commits; split it into migrations that commit separately, or, when one statement locks both tables \(a foreign key between two listed tables\), add a reviewed exception as supabase\/MIGRATIONS\.md describes$/u,
  );
});

test("the runner sends a migration after the boundary to the server as it is", (t) => {
  t.mock.method(console, "log", () => {});
  const run = fakeDocker(t);
  const rows = ["org_credit_ledger AccessExclusiveLock"];
  // psql passes a --command to the server without running a meta-command or
  // replacing a variable in it, as supabase db push does. It reads a file as
  // a script, where
  // select pg_current_xact_id() as fake_id \gset
  // \echo instafy-migration-xact :fake_id
  // \o /dev/null
  // forged the id rows and hid the probe's own.
  const sql = "alter table public.org_credit_ledger add column hyp text;\n";
  run(psqlOutput({ rows }), "", { sql });
  const { args, input } = run.psql();
  assert.deepEqual(args.slice(args.indexOf("--command")), [
    "--command",
    TRANSACTION_QUERY,
    "--command",
    sql,
    "--command",
    HELD_LOCK_QUERY,
  ]);
  assert.ok(!args.includes("--file") && !args.includes("--interactive"), args.join(" "));
  assert.equal(input, "");
  // psql runs a --command that starts with a backslash as a meta-command.
  assert.throws(
    () => run(psqlOutput({ rows }), "", { sql: "\\echo instafy-migration-xact 1066\nselect 1;\n" }),
    /^Error: public:20260000000064_public\.sql starts with a psql meta-command; a migration must be plain SQL$/u,
  );
  // Linux limits one argument to 128 KiB, its terminating NUL included.
  assert.equal(MAX_COMMAND_BYTES, 131_071);
  assert.throws(
    () => run(psqlOutput({ rows }), "", { sql: `-- ${"x".repeat(MAX_COMMAND_BYTES - 3)}\n` }),
    /^Error: public:20260000000064_public\.sql is larger than the 131071 bytes one psql --command can carry; split it$/u,
  );
  assert.doesNotThrow(() =>
    run(psqlOutput({ rows }), "", { sql: `-- ${"x".repeat(MAX_COMMAND_BYTES - 4)}\n` }),
  );
  // The limit counts bytes, not string length: \u00e9 takes two bytes in
  // UTF-8 and one place in a string, so each of these strings is about half
  // as long as the limit.
  const atLimit = `--${"\u00e9".repeat(65_534)}\n`;
  const overLimit = `-- ${"\u00e9".repeat(65_534)}\n`;
  assert.equal(Buffer.byteLength(atLimit), 131_071);
  assert.equal(Buffer.byteLength(overLimit), 131_072);
  assert.equal(overLimit.length, 65_538);
  assert.throws(
    () => run(psqlOutput({ rows }), "", { sql: overLimit }),
    /^Error: public:20260000000064_public\.sql is larger than the 131071 bytes one psql --command can carry; split it$/u,
  );
  assert.doesNotThrow(() => run(psqlOutput({ rows }), "", { sql: atLimit }));
  assert.equal(run.psql().args.at(-3), atLimit);
  // A failed psql names each query and the migration by its first line.
  assert.throws(
    () =>
      run("", "ERROR:  column \"hyp\" already exists\n", {
        sql: "-- The ledger column.\nalter table public.org_credit_ledger add column hyp text;\n",
        status: 1,
      }),
    /--command set local search_path = pg_catalog, pg_temp;\.\.\. --command -- The ledger column\.\.\.\. --command set local search_path = pg_catalog, pg_temp;\.\.\. failed: ERROR: {2}column "hyp" already exists$/u,
  );
});

test("the runner checks a migration on main against the first three tables", (t) => {
  t.mock.method(console, "log", () => {});
  const run = fakeDocker(t);
  // 20260816213318 as the empty database reports it: foreign keys to runs,
  // conversations and conversation_messages from the table it creates, and an
  // ALTER of agent_jobs.
  const rows = [
    "runs ShareRowExclusiveLock",
    "conversations ShareRowExclusiveLock",
    "conversation_messages ShareRowExclusiveLock",
    "agent_jobs AccessExclusiveLock",
  ];
  assert.doesNotThrow(() => run(psqlOutput({ rows }), "", { version: 20260816213318n }));
  assert.throws(
    () => run(psqlOutput({ rows }), "", { version: 20260929100200n }),
    /^Error: public:20260929100200_public\.sql writes or locks both agent_jobs and runs, agent_jobs and conversations, agent_jobs and conversation_messages, runs and conversations, /u,
  );
  // The first three still pair for it.
  assert.throws(
    () =>
      run(
        psqlOutput({ rows: ["agent_jobs AccessExclusiveLock", "org_credit_ledger RowExclusiveLock"] }),
        "",
        { version: 20260816213318n },
      ),
    /writes or locks both agent_jobs and org_credit_ledger until it commits/u,
  );
});

test("a migration sets its lock timeout only with a first top-level SET LOCAL", () => {
  for (const sql of [
    "set local lock_timeout = '5s';\nalter table agent_jobs add column hyp text;\n",
    "-- Bound the wait.\nSET LOCAL lock_timeout TO '5s';\nselect 1;\n",
    "/* a comment */ set local lock_timeout = 5000;\n",
    "set local lock_timeout = '1.5 min';\n",
    "set local lock_timeout = '1000us';\n",
  ]) {
    assert.equal(setsLockTimeoutFirst(sql), true, sql);
  }
  for (const sql of [
    "alter table agent_jobs add column hyp text;\n",
    // After the statement that takes the locks, it does not bound their wait.
    "alter table agent_jobs add column hyp text;\nset local lock_timeout = '5s';\n",
    // A comment, a string or a body sets nothing.
    "-- set local lock_timeout = '5s';\nalter table agent_jobs add column hyp text;\n",
    "/* set local lock_timeout = '5s'; */ alter table agent_jobs add column hyp text;\n",
    "select 'set local lock_timeout = ''5s''';\nset local lock_timeout = '5s';\n",
    "do $$ begin set local lock_timeout = '5s'; end $$;\n",
    // For the session, not the migration's own transaction.
    "set lock_timeout = '5s';\n",
    "set session lock_timeout = '5s';\n",
    // No bound at all, or less than the one millisecond Postgres rounds to.
    "set local lock_timeout = 0;\n",
    "set local lock_timeout = '0';\n",
    "set local lock_timeout = '500us';\n",
    "set local lock_timeout to default;\n",
    "set local lock_timeout = '5s\n",
    "set local statement_timeout = '5s';\n",
  ]) {
    assert.equal(setsLockTimeoutFirst(sql), false, sql);
  }
});

test("a migration under a reviewed lock exception mentions lock_timeout only where it sets it", () => {
  const first = "set local lock_timeout = '5s';\n";
  const statement =
    "alter table public.agent_jobs add column lease_id uuid references public.runtime_leases(id);\n";
  assert.equal(mentionsLockTimeoutOnce(`${first}${statement}`), true);
  assert.equal(mentionsLockTimeoutOnce(`-- Bound the wait.\n${first}${statement}`), true);
  // Each of these lifts the timeout before the statement that takes the
  // locks, and setsLockTimeoutFirst accepts every one.
  for (const lift of [
    "reset lock_timeout;\n",
    "set local lock_timeout = 0;\n",
    "SET LOCAL LOCK_TIMEOUT TO DEFAULT;\n",
    "set lock_timeout = 0;\n",
    "select set_config('lock_timeout', '0', true);\n",
    "do $$ begin perform set_config('lock_timeout', '0', true); end $$;\n",
  ]) {
    const sql = `${first}${lift}${statement}`;
    assert.equal(setsLockTimeoutFirst(sql), true, sql);
    assert.equal(mentionsLockTimeoutOnce(sql), false, sql);
  }
  // A comment that mentions it counts too.
  assert.equal(mentionsLockTimeoutOnce(`-- lock_timeout bounds the wait.\n${first}${statement}`), false);
  assert.equal(mentionsLockTimeoutOnce(`${first}${statement}-- lock_timeout is set.\n`), false);
});

test("a reviewed lock exception passes only the reviewed file, with its lock timeout first", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const run = fakeDocker(t);
  const version = 20260929100200n;
  // alter table agent_jobs add column lease_id uuid references runtime_leases(id);
  // as Postgres 17 reported it. The foreign key locks both tables in one
  // statement, so no split helps.
  const rows = [
    "agent_jobs AccessExclusiveLock",
    "agent_jobs AccessShareLock",
    "agent_jobs ShareRowExclusiveLock",
    "runtime_leases AccessShareLock",
    "runtime_leases ShareRowExclusiveLock",
  ];
  const first = "set local lock_timeout = '5s';\n";
  const statement =
    "alter table public.agent_jobs add column lease_id uuid references public.runtime_leases(id);\n";
  const sql = `${first}${statement}`;
  const sha256 = (text) => createHash("sha256").update(text).digest("hex");
  const reason = "agent_jobs.lease_id references runtime_leases";
  const reviewed = (text, pairs = [["agent_jobs", "runtime_leases"]]) =>
    new Map([[version, { sha256: sha256(text), pairs, reason }]]);
  const where = "public:20260929100200_public.sql";
  const failsWith = (message) => (error) => {
    assert.equal(error.message, message);
    return true;
  };

  // Without an entry, the message names both routes.
  assert.throws(
    () => run(psqlOutput({ rows }), "", { version, sql }),
    failsWith(
      `${where} writes or locks both agent_jobs and runtime_leases until it commits; split it into migrations that commit separately, or, when one statement locks both tables (a foreign key between two listed tables), add a reviewed exception as supabase/MIGRATIONS.md describes`,
    ),
  );
  // With an entry for the exact bytes and pairs and a lock timeout first, it
  // passes, and the run says what it let through and why.
  log.mock.resetCalls();
  assert.doesNotThrow(() =>
    run(psqlOutput({ rows }), "", { version, sql, exceptions: reviewed(sql) }),
  );
  assert.deepEqual(
    log.mock.calls.slice(0, 2).map(({ arguments: [line] }) => line),
    [
      `[empty-db:fake] ${where} writes or locks both agent_jobs and runtime_leases until it commits, under its reviewed lock exception: ${reason}`,
      `[empty-db:fake] applied ${where}`,
    ],
  );
  // The entry allows the pairs it lists and no others. Beside the foreign key,
  // alter table public.projects add column hyp text;
  // update public.runs set id = id where false;
  // add pairs that a split would remove.
  const overbroad = `${sql}alter table public.projects add column hyp text;\nupdate public.runs set id = id where false;\n`;
  assert.throws(
    () =>
      run(
        psqlOutput({ rows: [...rows, "projects AccessExclusiveLock", "runs RowExclusiveLock"] }),
        "",
        { version, sql: overbroad, exceptions: reviewed(overbroad) },
      ),
    failsWith(
      `${where} writes or locks both agent_jobs and runs, runs and runtime_leases, projects and agent_jobs, projects and runs, projects and runtime_leases until it commits, which its reviewed lock exception does not list; split it into migrations that commit separately, or have a reviewer add the pairs to its entry`,
    ),
  );
  // A pair is written as the message names it.
  assert.throws(
    () =>
      run(psqlOutput({ rows }), "", {
        version,
        sql,
        exceptions: reviewed(sql, [["runtime_leases", "agent_jobs"]]),
      }),
    failsWith(
      `${where} writes or locks both agent_jobs and runtime_leases until it commits, which its reviewed lock exception does not list; split it into migrations that commit separately, or have a reviewer add the pairs to its entry`,
    ),
  );
  // A reviewed pair the migration no longer holds is stale.
  assert.throws(
    () =>
      run(psqlOutput({ rows }), "", {
        version,
        sql,
        exceptions: reviewed(sql, [
          ["agent_jobs", "runtime_leases"],
          ["agent_jobs", "runs"],
        ]),
      }),
    failsWith(
      `${where} has a reviewed lock exception for agent_jobs and runs but no longer writes or locks them that way; remove them from its entry`,
    ),
  );
  // Any change to the file, even one more newline, needs a new review.
  const changed = `${sql}\n`;
  assert.throws(
    () => run(psqlOutput({ rows }), "", { version, sql: changed, exceptions: reviewed(sql) }),
    failsWith(
      `${where} changed since its lock exception was reviewed: its sha256 is ${sha256(changed)}, not the reviewed ${sha256(sql)}; have the change reviewed and update the entry`,
    ),
  );
  // The reviewed bytes must set a lock timeout first, not in a comment or
  // after the statement that takes the locks.
  for (const text of [
    statement,
    `${statement}${first}`,
    `-- ${first}${statement}`,
    `set local lock_timeout = 0;\n${statement}`,
  ]) {
    assert.throws(
      () => run(psqlOutput({ rows }), "", { version, sql: text, exceptions: reviewed(text) }),
      failsWith(
        `${where} has a reviewed lock exception but does not set a lock timeout first; start it with set local lock_timeout = '5s';`,
      ),
      text,
    );
  }
  // Nor lift it again before that statement.
  for (const lift of [
    "reset lock_timeout;\n",
    "set local lock_timeout = 0;\n",
    "select set_config('lock_timeout', '0', true);\n",
    "do $$ begin perform set_config('lock_timeout', '0', true); end $$;\n",
  ]) {
    const text = `${first}${lift}${statement}`;
    assert.throws(
      () => run(psqlOutput({ rows }), "", { version, sql: text, exceptions: reviewed(text) }),
      failsWith(
        `${where} has a reviewed lock exception but mentions lock_timeout outside its first statement; set it there once and mention it nowhere else, so that nothing after it can lift the timeout`,
      ),
      text,
    );
  }
  // RESET ALL lifts it without naming it, and the probe then reads 0.
  const resetAll = `${first}reset all;\n${statement}`;
  assert.throws(
    () =>
      run(psqlOutput({ rows, lockTimeout: "0" }), "", {
        version,
        sql: resetAll,
        exceptions: reviewed(resetAll),
      }),
    failsWith(
      `${where} has a reviewed lock exception but leaves lock_timeout at 0 before it commits; set it once, first, and do not lift it`,
    ),
  );
  // A row the migration prints cannot stand in for the probe's.
  const forged = `${first}select 'instafy-migration-lock-timeout 5000';\nreset all;\n${statement}`;
  assert.throws(
    () =>
      run(
        psqlOutput({
          rows,
          lockTimeout: "0",
          tags: ["SET", ...aligned(["instafy-migration-lock-timeout 5000"]), "RESET", "ALTER TABLE"],
        }),
        "",
        { version, sql: forged, exceptions: reviewed(forged) },
      ),
    failsWith(
      `${where} has a reviewed lock exception but its lock_timeout could not be read before it commits; set it once, first, and do not lift it`,
    ),
  );
  // An entry cannot outlive the violation it excuses.
  assert.throws(
    () =>
      run(psqlOutput({ rows: ["agent_jobs AccessExclusiveLock"] }), "", {
        version,
        sql,
        exceptions: reviewed(sql),
      }),
    failsWith(
      `${where} has a reviewed lock exception but no longer writes or locks two tables that way; remove its entry`,
    ),
  );
  // Nor the migration it names, which the runner checks before it starts a
  // container.
  assert.throws(
    () =>
      run(psqlOutput({ rows }), "", {
        version,
        sql,
        exceptions: new Map([
          [20260929100400n, { sha256: sha256(sql), pairs: [["agent_jobs", "runtime_leases"]], reason }],
        ]),
      }),
    failsWith(
      "reviewed lock exception 20260929100400 names no migration after 20260000000063; remove it",
    ),
  );
});

test("reviewed lock exceptions name a checked migration with its sha256, its pairs and a one-line reason", () => {
  const plan = [{ version: 20260000000063n }, { version: 20260929100200n }];
  const entry = {
    sha256: "a".repeat(64),
    pairs: [["agent_jobs", "runtime_leases"]],
    reason: "agent_jobs.lease_id references runtime_leases",
  };
  assert.doesNotThrow(() =>
    validateReviewedLockExceptions(new Map([[20260929100200n, entry]]), plan),
  );
  assert.doesNotThrow(() =>
    validateReviewedLockExceptions(
      new Map([[20260929100200n, { ...entry, pairs: [...entry.pairs, ["projects", "agent_jobs"]] }]]),
      plan,
    ),
  );
  // The legacy history runs without the lock check, so an entry for it would
  // never apply, and a version as a string or a number matches no migration.
  for (const version of [20260000000063n, 20260929100400n, "20260929100200", 20260929100200]) {
    assert.throws(
      () => validateReviewedLockExceptions(new Map([[version, entry]]), plan),
      new RegExp(
        `^Error: reviewed lock exception ${version} names no migration after 20260000000063; remove it$`,
        "u",
      ),
      `${typeof version} ${version}`,
    );
  }
  const { pairs, ...withoutPairs } = entry;
  for (const bad of [
    null,
    { reason: entry.reason, pairs },
    { ...entry, sha256: "A".repeat(64) },
    { ...entry, sha256: "a".repeat(63) },
    { sha256: entry.sha256, pairs },
    { ...entry, reason: " " },
    { ...entry, reason: "one line\nand another" },
    withoutPairs,
    { ...entry, pairs: [] },
    { ...entry, pairs: "agent_jobs and runtime_leases" },
    { ...entry, pairs: ["agent_jobs", "runtime_leases"] },
    { ...entry, pairs: [["agent_jobs"]] },
    { ...entry, pairs: [["agent_jobs", "runtime_leases", "runs"]] },
    { ...entry, pairs: [["agent_jobs", "agent_jobs"]] },
    { ...entry, pairs: [["agent_jobs", 1]] },
    { ...entry, pairs: [["agent_jobs", "public.runtime_leases"]] },
    { ...entry, pairs: [...pairs, ["agent_jobs", "runtime_leases"]] },
  ]) {
    assert.throws(
      () => validateReviewedLockExceptions(new Map([[20260929100200n, bad]]), plan),
      /^Error: reviewed lock exception 20260929100200 needs the sha256 of its migration, the pairs of tables it allows and a one-line reason$/u,
      JSON.stringify(bad),
    );
  }
});

test("each checked-in reviewed lock exception matches its migration", () => {
  const track = validatePublicMigrationTrack();
  assert.doesNotThrow(() => validateReviewedLockExceptions(REVIEWED_LOCK_EXCEPTIONS, track));
  for (const [version, { sha256 }] of REVIEWED_LOCK_EXCEPTIONS) {
    const source = readFileSync(track.find((migration) => migration.version === version).source);
    assert.equal(createHash("sha256").update(source).digest("hex"), sha256, `${version}`);
    assert.ok(setsLockTimeoutFirst(source.toString("utf8")), `${version}`);
    assert.ok(mentionsLockTimeoutOnce(source.toString("utf8")), `${version}`);
  }
});
