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

import { validatePublicMigrationTrack } from "./check-supabase-migrations.mjs";

function fixture() {
  return mkdtempSync(path.join(os.tmpdir(), "instafy-public-migrations-"));
}

function migration(directory, name) {
  writeFileSync(path.join(directory, name), `-- ${name}\nselect 1;\n`);
}

test("the checked-in pre-split migration history matches its immutable baseline", () => {
  assert.equal(validatePublicMigrationTrack().length, 64);
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
