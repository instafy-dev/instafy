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
  topLevelMetaCommands,
  topLevelStatementKeywords,
  topLevelStatements,
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
