import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupabaseStartArgs,
  parseSupabaseDatabaseOnly,
} from "./supabaseStartMode.mjs";

test("default Supabase startup remains the complete local stack", () => {
  assert.equal(parseSupabaseDatabaseOnly(undefined), false);
  assert.equal(parseSupabaseDatabaseOnly(""), false);
  assert.equal(parseSupabaseDatabaseOnly("0"), false);
  assert.deepEqual(buildSupabaseStartArgs(undefined), ["start"]);
  assert.deepEqual(buildSupabaseStartArgs("0", { ignoreHealthCheck: true }), [
    "start",
    "--ignore-health-check",
  ]);
});

test("database-only startup uses the CLI's dedicated Postgres command", () => {
  assert.equal(parseSupabaseDatabaseOnly("1"), true);
  assert.deepEqual(buildSupabaseStartArgs("1"), ["db", "start"]);
  assert.deepEqual(buildSupabaseStartArgs("1", { ignoreHealthCheck: true }), [
    "db",
    "start",
  ]);
});

test("database-only startup rejects ambiguous opt-in values", () => {
  for (const value of ["true", "yes", " 1 ", "false", 1]) {
    assert.throws(
      () => parseSupabaseDatabaseOnly(value),
      /SUPABASE_DATABASE_ONLY must be unset, 0, or 1/,
    );
  }
});
