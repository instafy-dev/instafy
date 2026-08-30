import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validatePublicMigrationTrack } from "./check-supabase-migrations.mjs";
import {
  POSTGRES_IMAGE,
  REQUIRED_PUBLIC_RELATIONS,
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
