import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_PUBLIC_MIGRATION_COUNT,
  LANE_BOUNDARY,
  checkAddedMigrationsSortLast,
  githubEventBase,
  main,
  migrationFileNamesAt,
  parseArguments,
  resolveBaseCommit,
  topLevelMetaCommands,
  topLevelStatementKeywords,
  topLevelStatements,
  validatePublicMigrationTrack,
} from "./check-supabase-migrations.mjs";

// git looks for its repository in GIT_DIR and its relatives before the working
// directory, and it sets them for `git rebase --exec` commands and for hooks.
// Without them, the fixtures below, and the script run against them, use the
// repository their working directory is in.
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]) {
  delete process.env[name];
}

const SCRIPT = fileURLToPath(new URL("./check-supabase-migrations.mjs", import.meta.url));

function fixture() {
  return mkdtempSync(path.join(os.tmpdir(), "instafy-public-migrations-"));
}

function migration(directory, name) {
  writeFileSync(path.join(directory, name), `-- ${name}\nselect 1;\n`);
}

function names(migrations) {
  return migrations.map(({ fileName }) => fileName);
}

// A git repository of its own with a supabase/migrations directory. Its git
// commands read no user or system configuration.
function repository(t) {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: directory, encoding: "utf8", env },
    ).trim();
  const migrations = path.join(directory, "supabase", "migrations");
  mkdirSync(migrations, { recursive: true });
  git("init", "-q", "-b", "main");
  const commit = (...files) => {
    for (const file of files) {
      migration(migrations, file);
    }
    git("add", "--all");
    git("commit", "-q", "-m", files.join(" "));
    return git("rev-parse", "HEAD");
  };
  return { commit, directory, git, migrations };
}

// A branch adds `branchMigration` while main lands 20260000000070 first, and
// HEAD is the test merge GitHub builds for a pull request: a merge commit
// whose first parent is the base, main.
function testMerge(t, branchMigration) {
  const repo = repository(t);
  const start = repo.commit("20260000000064_first.sql", "20260000000066_second.sql");
  repo.git("checkout", "-q", "-b", "branch", start);
  repo.commit(branchMigration);
  repo.git("checkout", "-q", "main");
  const base = repo.commit("20260000000070_landed_first.sql");
  repo.git("merge", "-q", "--no-ff", "--no-edit", "branch");
  return { ...repo, base };
}

const PULL_REQUEST = { GITHUB_EVENT_NAME: "pull_request" };

test("the checked-in pre-split migration history matches its immutable baseline", () => {
  const legacyMigrations = validatePublicMigrationTrack().filter(
    ({ version }) => version <= LANE_BOUNDARY,
  );
  assert.equal(legacyMigrations.length, LEGACY_PUBLIC_MIGRATION_COUNT);
});

test("legacy history and the post-split even lane validate", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  migration(directory, "20260000000063_legacy.sql");
  migration(directory, "20260000000064_public.sql");
  assert.deepEqual(
    validatePublicMigrationTrack(directory).map(({ fileName }) => fileName),
    ["20260000000063_legacy.sql", "20260000000064_public.sql"],
  );
});

test("post-split odd versions are reserved for downstream overlays", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  migration(directory, "20260000000065_wrong_lane.sql");
  assert.throws(
    () => validatePublicMigrationTrack(directory),
    /reserved even version lane/u,
  );
});

test("invalid, empty, and special entries fail closed", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  writeFileSync(path.join(directory, "bad.sql"), "select 1;\n");
  assert.throws(
    () => validatePublicMigrationTrack(directory),
    /invalid public migration filename/u,
  );
  rmSync(path.join(directory, "bad.sql"));
  writeFileSync(path.join(directory, "20260000000064_empty.sql"), "");
  assert.throws(
    () => validatePublicMigrationTrack(directory),
    /public migration is empty/u,
  );
  rmSync(path.join(directory, "20260000000064_empty.sql"));
  mkdirSync(path.join(directory, "nested"));
  assert.throws(
    () => validatePublicMigrationTrack(directory),
    /contains a non-file/u,
  );
});

test("a migration may not end or open the transaction it runs in", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const name = "20260000000064_public.sql";
  for (const [keyword, sql] of [
    ["BEGIN", "begin;\ncreate table t (id int);\n"],
    ["COMMIT", "create table t (id int);\ncommit;\nalter table t add column c text;\n"],
    ["COMMIT", "create table t (id int);\nCOMMIT AND CHAIN;\n"],
    ["END", "create table t (id int);\nend;\n"],
    ["ROLLBACK", "create table t (id int);\nrollback;\n"],
    ["START", "start transaction;\ncreate table t (id int);\n"],
    ["ABORT", "/* a comment */ abort;\n"],
  ]) {
    writeFileSync(path.join(directory, name), sql);
    assert.throws(
      () => validatePublicMigrationTrack(directory),
      new RegExp(`${name} has a top-level ${keyword};`, "u"),
      sql,
    );
  }
  // BEGIN and END inside a body, a string, a quoted name or a comment are not
  // transaction control.
  writeFileSync(
    path.join(directory, name),
    [
      "do $$ begin perform 1; end $$;",
      "create function f() returns int as $body$ begin return 1; end; $body$ language plpgsql;",
      "create function g() returns int language sql begin atomic select case when true then 1 end; end;",
      "create function h() returns text as 'begin; commit;' language sql;",
      "select E'it\\'s; commit;', \"end;\", 'a;''commit';",
      "/* nested /* ; */ commit; */ select 1; -- rollback;",
      "",
    ].join("\n"),
  );
  assert.equal(validatePublicMigrationTrack(directory).length, 1);
});

test("a migration may not contain a psql meta-command", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const name = "20260000000064_public.sql";
  for (const [command, sql] of [
    // Forged the id rows the empty-database test reads and hid the probe's
    // own, and passed both checks.
    [
      "\\gset",
      [
        "select pg_current_xact_id() as fake_id \\gset",
        "\\echo instafy-migration-xact :fake_id",
        "\\o /dev/null",
        "create table t (id int);",
        "",
      ].join("\n"),
    ],
    ["\\echo", "\\echo instafy-migration-xact 1066\n"],
    ["\\o", "create table t (id int);\n  \\o /dev/null\n"],
    ["\\i", "create table t (\n  id int\n\\i other.sql\n);\n"],
    ["\\!", "create table t (id int); \\! true\n"],
    // psql reads 1e as one token and '\' as a plain string, then runs \r,
    // which drops the junk before the server sees it, and the lines after.
    // Read as an E'...' string, it hid them all from this check.
    [
      "\\r",
      [
        "alter table organizations add column x text;",
        "alter table org_credit_balances add column y text;",
        "1e'\\' \\r",
        "select pg_current_xact_id() as fake_id \\gset",
        "\\echo instafy-migration-xact :fake_id",
        "\\o /dev/null",
        "",
      ].join("\n"),
    ],
    ["\\r", "select 0x1e'\\' \\r\n"],
    ["\\r", "select 1.e'\\' \\r\n"],
  ]) {
    writeFileSync(path.join(directory, name), sql);
    assert.throws(
      () => validatePublicMigrationTrack(directory),
      new RegExp(
        `${name} has the psql meta-command ${command.replace(/\\/gu, "\\\\")}; a migration must be plain SQL$`,
        "u",
      ),
      sql,
    );
  }
  // A backslash in a string, a quoted name, a comment or a body is not one.
  const plain = [
    "select E'a\\\\b\\n', 'a\\', '^x\\.y$', \"we\\ird\";",
    "do $$ begin raise notice '\\echo'; end $$;",
    "create function f() returns text as $body$ select '\\o'::text $body$ language sql;",
    "-- \\echo in a comment",
    "/* \\o /dev/null */ select 1;",
    "",
  ].join("\n");
  assert.deepEqual(topLevelMetaCommands(plain), []);
  writeFileSync(path.join(directory, name), plain);
  assert.equal(validatePublicMigrationTrack(directory).length, 1);
  assert.deepEqual(
    topLevelMetaCommands("select 1 \\gset\n\\echo x\nselect 2;\n\\o\n"),
    ["\\gset", "\\echo", "\\o"],
  );
  // An E'...' string still escapes its quote with a backslash.
  assert.deepEqual(topLevelMetaCommands("select e'\\' \\r', 1 e'\\' \\r';\n"), []);
});

test("a migration may not change standard_conforming_strings", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const name = "20260000000064_public.sql";
  for (const sql of [
    // With it off, psql reads 'x\'' as the string x', and this check read the
    // rest of the file as a string, so the meta-commands after it passed.
    [
      "set standard_conforming_strings = off;",
      "select 'x\\'';",
      "select pg_current_xact_id() as fake_id \\gset",
      "\\echo instafy-migration-xact :fake_id",
      "\\o /dev/null",
      "",
    ].join("\n"),
    "SET LOCAL Standard_Conforming_Strings TO off;\n",
    "select set_config('standard_conforming_strings', 'off', true);\n",
    "alter role postgres set standard_conforming_strings = off;\n",
  ]) {
    writeFileSync(path.join(directory, name), sql);
    assert.throws(
      () => validatePublicMigrationTrack(directory),
      new RegExp(
        `${name} mentions standard_conforming_strings; a migration must keep the server's default string syntax$`,
        "u",
      ),
      sql,
    );
  }
});

test("a migration must be valid UTF-8", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const name = "20260000000064_public.sql";
  // The server rejected the first, whose 0xe9 is a Latin-1 e with an acute
  // accent, when psql sent the file's bytes. Read as a string, the byte became
  // U+FFFD, which the server took when the empty-database test passed the
  // migration to psql as a --command.
  for (const [before, bytes, after] of [
    ["select 'caf", [0xe9], "';\n"],
    // A truncated two-byte sequence, an overlong encoding of "/", and a byte
    // in a comment.
    ["select '", [0xc3], "';\n"],
    ["select '", [0xc0, 0xaf], "';\n"],
    ["-- ", [0xe9], "\nselect 1;\n"],
  ]) {
    const source = Buffer.concat([Buffer.from(before), Buffer.from(bytes), Buffer.from(after)]);
    writeFileSync(path.join(directory, name), source);
    assert.throws(
      () => validatePublicMigrationTrack(directory),
      new RegExp(`^Error: public migration ${name} is not valid UTF-8$`, "u"),
      source.toString("hex"),
    );
  }
  // The same character encoded as UTF-8.
  writeFileSync(path.join(directory, name), "-- é\nselect 'é';\n");
  assert.equal(validatePublicMigrationTrack(directory).length, 1);
  // psql passed a leading byte order mark to the server as part of the first
  // statement of a --command, where it was a syntax error.
  for (const sql of ["\ufeffselect 1;\n", "\ufeff-- A comment.\nselect 1;\n"]) {
    writeFileSync(path.join(directory, name), sql);
    assert.throws(
      () => validatePublicMigrationTrack(directory),
      new RegExp(
        `^Error: public migration ${name} starts with a byte order mark; save it as UTF-8 without a BOM$`,
        "u",
      ),
      sql,
    );
  }
  // The same character anywhere else is a zero-width no-break space.
  writeFileSync(path.join(directory, name), "select '\ufeff';\n");
  assert.equal(validatePublicMigrationTrack(directory).length, 1);
});

test("statements split the way psql splits them", () => {
  // psql ran this as 10 statements, in this order.
  assert.deepEqual(
    topLevelStatementKeywords(
      [
        "create function lex_f1() returns int language sql begin atomic select 1; end;",
        "create or replace procedure lex_p1() language sql begin atomic select case when true then 1 end; select 2; end;",
        "select E'it\\'s ; commit';",
        "select 'a;''b';",
        'select "we;ird" from (select 1 as "we;ird") t;',
        "/* nested /* ; */ commit; */ select 1;",
        "do $body$ begin perform 1; end $body$;",
        "select $$;$$;",
        "select (select 1); -- ; commit",
        "create function lex_f2() returns int as 'select 1; ' language sql;",
      ].join("\n"),
    ),
    ["create", "create", "select", "select", "select", "select", "do", "select", "select", "create"],
  );
});

test("each top-level statement keeps its words, and its strings whole", () => {
  assert.deepEqual(
    topLevelStatements(
      [
        "-- set local lock_timeout = '1s';",
        "SET LOCAL lock_timeout TO '5s';",
        "/* ; */ select 'a;''b', \"We;ird\", 1.5e3 from t where x = $$;$$;",
        "do $$ begin set local lock_timeout = 0; end $$;",
        "create function f() returns int language sql begin atomic select 1; end;",
        "select 2",
      ].join("\n"),
    ),
    [
      ["set", "local", "lock_timeout", "to", "'5s'"],
      ["select", "'a;''b'", "\"We;ird\"", "1.5e3", "from", "t", "where", "x"],
      ["do"],
      [
        "create",
        "function",
        "f",
        "returns",
        "int",
        "language",
        "sql",
        "begin",
        "atomic",
        "select",
        "1",
        "end",
      ],
      ["select", "2"],
    ],
  );
});

test("a migration a change adds must sort after the newest one at its base", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const base = ["20260000000064_first.sql", "20260000000068_third.sql"];
  for (const name of base) {
    migration(directory, name);
  }
  const check = () =>
    checkAddedMigrationsSortLast(validatePublicMigrationTrack(directory), base, "main");
  assert.deepEqual(check(), { added: [], newest: { fileName: base[1], version: 20260000000068n } });

  migration(directory, "20260000000070_next.sql");
  assert.deepEqual(names(check().added), ["20260000000070_next.sql"]);

  migration(directory, "20260000000066_late.sql");
  assert.throws(
    check,
    /public migration 20260000000066_late\.sql is not newer than 20260000000068_third\.sql, the newest migration at main; migration history is append-only, so rename it to a current UTC timestamp after 20260000000068, with an even final digit$/u,
  );
  migration(directory, "20260000000062_later.sql");
  assert.throws(
    check,
    /public migrations 20260000000062_later\.sql, 20260000000066_late\.sql are not newer than 20260000000068_third\.sql.* rename each to/u,
  );
});

test("a migration renamed at its base's newest version is not newer, and an empty base takes any", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  migration(directory, "20260000000064_first.sql");
  migration(directory, "20260000000066_renamed.sql");
  const track = validatePublicMigrationTrack(directory);
  assert.throws(
    () =>
      checkAddedMigrationsSortLast(track, ["20260000000064_first.sql", "20260000000066_second.sql"], "main"),
    /public migration 20260000000066_renamed\.sql is not newer than 20260000000066_second\.sql/u,
  );
  assert.deepEqual(checkAddedMigrationsSortLast(track, [], "main"), { added: track, newest: null });
  // A base entry that is not a migration file name sets no newest version.
  assert.deepEqual(
    names(checkAddedMigrationsSortLast(track, ["README.md", "20260000000064_first.sql"], "main").added),
    ["20260000000066_renamed.sql"],
  );
});

test("a pull request's test merge is compared with its first parent, the base it merged into", (t) => {
  const late = testMerge(t, "20260000000068_late.sql");
  const event = githubEventBase({ env: PULL_REQUEST, repoRoot: late.directory });
  assert.equal(event.base, late.base);
  assert.equal(event.label, `the pull request's base ${late.base.slice(0, 12)}`);
  const atBase = migrationFileNamesAt(resolveBaseCommit(event.base, late.directory), {
    repoRoot: late.directory,
  });
  assert.deepEqual(atBase, [
    "20260000000064_first.sql",
    "20260000000066_second.sql",
    "20260000000070_landed_first.sql",
  ]);
  assert.throws(
    () => checkAddedMigrationsSortLast(validatePublicMigrationTrack(late.migrations), atBase, event.label),
    /public migration 20260000000068_late\.sql is not newer than 20260000000070_landed_first\.sql, the newest migration at the pull request's base /u,
  );

  const renamed = testMerge(t, "20260000000072_renamed.sql");
  const renamedEvent = githubEventBase({ env: PULL_REQUEST, repoRoot: renamed.directory });
  assert.deepEqual(
    names(
      checkAddedMigrationsSortLast(
        validatePublicMigrationTrack(renamed.migrations),
        migrationFileNamesAt(renamedEvent.base, { repoRoot: renamed.directory }),
        renamedEvent.label,
      ).added,
    ),
    ["20260000000072_renamed.sql"],
  );
});

test("a checkout two commits deep holds the base of a test merge, and one commit deep fails", (t) => {
  const repo = testMerge(t, "20260000000072_branch.sql");
  for (const depth of [2, 1]) {
    const clone = fixture();
    t.after(() => rmSync(clone, { force: true, recursive: true }));
    repo.git("clone", "-q", `--depth=${depth}`, `file://${repo.directory}`, clone);
    if (depth === 2) {
      const event = githubEventBase({ env: PULL_REQUEST, repoRoot: clone });
      assert.equal(event.base, repo.base);
      assert.deepEqual(migrationFileNamesAt(resolveBaseCommit(event.base, clone), { repoRoot: clone }), [
        "20260000000064_first.sql",
        "20260000000066_second.sql",
        "20260000000070_landed_first.sql",
      ]);
    } else {
      assert.throws(
        () => githubEventBase({ env: PULL_REQUEST, repoRoot: clone }),
        /must check out GitHub's test merge commit with both of its parents \(fetch-depth: 2\)/u,
      );
      assert.throws(() => resolveBaseCommit(repo.base, clone), /is not in this checkout/u);
    }
  }
});

test("a base git cannot look up for another reason fails with git's own error", (t) => {
  const directory = realpathSync(fixture());
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const plain = path.join(directory, "plain");
  mkdirSync(plain);
  // Stop git's search for a repository at the fixture, wherever the temporary
  // directory is.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = directory;
  t.after(() => {
    if (ceiling === undefined) {
      delete process.env.GIT_CEILING_DIRECTORIES;
    } else {
      process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
  // git words its error in the developer's language, so check how it failed.
  assert.throws(
    () => resolveBaseCommit("HEAD", plain),
    (error) =>
      error.status === 128 &&
      error.message.startsWith("Command failed: git rev-parse --verify --quiet HEAD^{commit}"),
  );
});

test("a merge group is compared with the parent its event names", (t) => {
  const repo = repository(t);
  const parent = repo.commit("20260000000064_first.sql", "20260000000068_queued_ahead.sql");
  repo.commit("20260000000066_late.sql");
  const eventPath = path.join(fixture(), "event.json");
  t.after(() => rmSync(path.dirname(eventPath), { force: true, recursive: true }));
  const mergeGroup = (payload) => {
    writeFileSync(eventPath, JSON.stringify(payload));
    return githubEventBase({
      env: { GITHUB_EVENT_NAME: "merge_group", GITHUB_EVENT_PATH: eventPath },
      repoRoot: repo.directory,
    });
  };
  const event = mergeGroup({ merge_group: { base_sha: parent } });
  assert.deepEqual(event, { base: parent, label: `the merge group's parent ${parent.slice(0, 12)}` });
  assert.throws(
    () =>
      checkAddedMigrationsSortLast(
        validatePublicMigrationTrack(repo.migrations),
        migrationFileNamesAt(resolveBaseCommit(event.base, repo.directory), { repoRoot: repo.directory }),
        event.label,
      ),
    /public migration 20260000000066_late\.sql is not newer than 20260000000068_queued_ahead\.sql, the newest migration at the merge group's parent /u,
  );
  const absent = mergeGroup({ merge_group: { base_sha: "0".repeat(40) } });
  assert.throws(() => resolveBaseCommit(absent.base, repo.directory), /is not in this checkout/u);
  assert.throws(() => mergeGroup({ merge_group: {} }), /names no base_sha/u);
  assert.throws(() => mergeGroup({ merge_group: { base_sha: "main" } }), /names no base_sha/u);
  assert.throws(
    () => githubEventBase({ env: { GITHUB_EVENT_NAME: "merge_group" }, repoRoot: repo.directory }),
    /needs the event payload GITHUB_EVENT_PATH names/u,
  );
});

test("other runs have no base, and the flag needs GitHub's event name and a test merge", (t) => {
  const repo = repository(t);
  repo.commit("20260000000064_first.sql");
  for (const name of ["push", "workflow_dispatch"]) {
    assert.equal(githubEventBase({ env: { GITHUB_EVENT_NAME: name }, repoRoot: repo.directory }), null);
  }
  assert.throws(() => githubEventBase({ env: {}, repoRoot: repo.directory }), /GITHUB_EVENT_NAME/u);
  // Neither a root commit nor an ordinary commit with one parent is a test
  // merge, whose first parent is the base.
  for (const next of [null, "20260000000066_second.sql"]) {
    if (next) {
      repo.commit(next);
    }
    assert.throws(
      () => githubEventBase({ env: PULL_REQUEST, repoRoot: repo.directory }),
      /must check out GitHub's test merge commit/u,
      String(next),
    );
  }
});

test("the command takes --base <commit> or --base-from-github-event, and nothing else", () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["--base", "origin/main"]), { base: "origin/main" });
  assert.deepEqual(parseArguments(["--base-from-github-event"]), { fromGithubEvent: true });
  for (const args of [
    ["--base"],
    ["--base", ""],
    ["--base", "--base-from-github-event"],
    ["--base-from-github-event", "--base", "main"],
    ["main"],
  ]) {
    assert.throws(() => parseArguments(args), /^Error: usage: /u, JSON.stringify(args));
  }
  const run = (args, env = process.env) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  const bad = run(["--base"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^Public migration validation failed: usage: /u);
  const push = run(["--base-from-github-event"], { ...process.env, GITHUB_EVENT_NAME: "push" });
  assert.equal(push.status, 0, push.stderr);
  assert.match(
    push.stdout,
    /^Validated \d+ public Supabase migration\(s\); a push run has no base to compare with$/mu,
  );
  const head = run(["--base", "HEAD"]);
  assert.equal(head.status, 0, head.stderr);
  assert.match(
    head.stdout,
    /^Validated \d+ public Supabase migration\(s\); (?:none added since HEAD|the \d+ added since HEAD sort after \S+)$/mu,
  );
});

test("the command compares a pull request's test merge with its base from end to end", (t) => {
  const run = (repo, args, env) => {
    const lines = [];
    main({ args, env, repoRoot: repo.directory, directory: repo.migrations, log: (line) => lines.push(line) });
    return lines;
  };
  const late = testMerge(t, "20260000000068_late.sql");
  for (const [args, env] of [
    [["--base-from-github-event"], PULL_REQUEST],
    [["--base", "HEAD^1"], {}],
  ]) {
    assert.throws(
      () => run(late, args, env),
      /public migration 20260000000068_late\.sql is not newer than 20260000000070_landed_first\.sql/u,
      JSON.stringify(args),
    );
  }
  assert.deepEqual(run(late, ["--base-from-github-event"], { GITHUB_EVENT_NAME: "push" }), [
    "Validated 4 public Supabase migration(s); a push run has no base to compare with",
  ]);
  assert.deepEqual(run(late, [], PULL_REQUEST), ["Validated 4 public Supabase migration(s)"]);

  const next = testMerge(t, "20260000000072_next.sql");
  assert.deepEqual(run(next, ["--base-from-github-event"], PULL_REQUEST), [
    `Validated 4 public Supabase migration(s); the 1 added since the pull request's base ${next.base.slice(0, 12)} sort after 20260000000070_landed_first.sql`,
  ]);
  assert.deepEqual(run(next, ["--base", next.base], {}), [
    `Validated 4 public Supabase migration(s); the 1 added since ${next.base} sort after 20260000000070_landed_first.sql`,
  ]);
  assert.deepEqual(run(next, ["--base", "HEAD"], {}), [
    "Validated 4 public Supabase migration(s); none added since HEAD",
  ]);
});

test("a base with no migrations to compare with fails rather than passing every migration", (t) => {
  const run = (repoRoot, directory, args) =>
    main({ args, env: {}, repoRoot, directory, log: () => {} });
  // A base from before the history began.
  const repo = repository(t);
  writeFileSync(path.join(repo.directory, "README.md"), "fixture\n");
  repo.git("add", "README.md");
  repo.git("commit", "-q", "-m", "README.md");
  repo.commit("20260000000064_first.sql");
  assert.throws(
    () => run(repo.directory, repo.migrations, ["--base", "HEAD^1"]),
    /^Error: HEAD\^1 has no public migrations in supabase\/migrations to compare with; run this from a checkout of this repository whose history includes them$/u,
  );
  // A copy inside another repository, whose own top level has no migrations:
  // git lists the base from that top level.
  const outer = repository(t);
  const copy = path.join(outer.directory, "vendor", "core");
  const copied = path.join(copy, "supabase", "migrations");
  mkdirSync(copied, { recursive: true });
  migration(copied, "20260000000064_first.sql");
  outer.git("add", "--all");
  outer.git("commit", "-q", "-m", "vendor/core");
  assert.throws(
    () => run(copy, copied, ["--base", "HEAD"]),
    /^Error: HEAD has no public migrations in supabase\/migrations to compare with; /u,
  );
});
