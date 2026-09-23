import assert from "node:assert/strict";
import test from "node:test";

import { SKIP_MIGRATIONS_ENV, shouldApplyLocalMigrations } from "./controllerTestMigrations.mjs";

test("migrates the local stack by default", () => {
  assert.equal(shouldApplyLocalMigrations({ explicitDbUrl: null, env: {} }), true);
});

test("never migrates an explicitly configured database", () => {
  assert.equal(
    shouldApplyLocalMigrations({ explicitDbUrl: "postgresql://ci.example/db", env: {} }),
    false,
  );
});

for (const value of ["1", "true", "TRUE", " yes "]) {
  test(`skips when ${SKIP_MIGRATIONS_ENV}=${JSON.stringify(value)}`, () => {
    assert.equal(
      shouldApplyLocalMigrations({ explicitDbUrl: null, env: { [SKIP_MIGRATIONS_ENV]: value } }),
      false,
    );
  });
}

for (const value of ["", "0", "false", "no"]) {
  test(`still migrates when ${SKIP_MIGRATIONS_ENV}=${JSON.stringify(value)}`, () => {
    assert.equal(
      shouldApplyLocalMigrations({ explicitDbUrl: null, env: { [SKIP_MIGRATIONS_ENV]: value } }),
      true,
    );
  });
}
