import assert from "node:assert/strict";
import test from "node:test";

import { validatePublicMigrationTrack } from "./check-supabase-migrations.mjs";
import {
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
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
