import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_PUBLIC_MIGRATION_COUNT,
  LANE_BOUNDARY,
  topLevelStatementKeywords,
  validatePublicMigrationTrack,
} from "./check-supabase-migrations.mjs";

function fixture() {
  return mkdtempSync(path.join(os.tmpdir(), "instafy-public-migrations-"));
}

function migration(directory, name) {
  writeFileSync(path.join(directory, name), `-- ${name}\nselect 1;\n`);
}

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
