import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cacheTagFor,
  pullPinnedImage,
  resolvePinnedPostgresImage,
} from "./ensure-supabase-postgres-image.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

test("resolves the exact digest-pinned image from the migration script", () => {
  const source = readFileSync(
    path.join(MODULE_DIR, "test-supabase-migrations-empty-db.mjs"),
    "utf8",
  );
  const image = resolvePinnedPostgresImage(source);
  // The single source of truth is the migration script; this helper must read
  // it rather than carry a second copy of the digest that can go stale.
  assert.match(
    image,
    /^public\.ecr\.aws\/supabase\/postgres@sha256:[0-9a-f]{64}$/u,
  );
  assert.ok(source.includes(`"${image}"`));
});

test("rejects sources without a digest-pinned reference", () => {
  assert.throws(() => resolvePinnedPostgresImage("const IMAGE = 'postgres:16';"));
  // A tag-pinned reference must not satisfy the digest requirement either.
  assert.throws(() =>
    resolvePinnedPostgresImage('"public.ecr.aws/supabase/postgres:15.1"'),
  );
});

test("the build workflow ensures the image before running migrations", () => {
  const workflow = readFileSync(
    path.join(MODULE_DIR, "..", ".github", "workflows", "build.yml"),
    "utf8",
  );
  // The cache restore must come first, then the ensure step, then the
  // migration test that does the implicit docker run. Out of order, the
  // ensure step pulls from ECR every run and the flake returns.
  const cacheIndex = workflow.indexOf("supabase-postgres-image");
  const ensureIndex = workflow.indexOf("scripts/ensure-supabase-postgres-image.mjs");
  const migrateIndex = workflow.indexOf(
    "run: node scripts/test-supabase-migrations-empty-db.mjs",
  );
  assert.ok(cacheIndex > -1, "build.yml must restore the postgres image cache");
  assert.ok(ensureIndex > -1, "build.yml must run the ensure script");
  assert.ok(migrateIndex > -1, "build.yml must still run the migration test");
  assert.ok(cacheIndex < ensureIndex, "cache restore must precede the ensure step");
  assert.ok(ensureIndex < migrateIndex, "ensure must precede the migration test");
  // The cache key binds the runner platform as well as the digest-bearing file:
  // an AMD64 tarball must not be reused on the independently native ARM64 lane.
  assert.match(
    workflow,
    /supabase-postgres-image-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ hashFiles\('scripts\/test-supabase-migrations-empty-db\.mjs'\) \}\}/u,
  );
});

test("cache tag binds the digest and rejects unpinned references", () => {
  const tag = cacheTagFor(
    "public.ecr.aws/supabase/postgres@sha256:" + "a".repeat(64),
  );
  // The tag must carry the digest hex so the cache can only ever be addressed
  // by content identity, never by a floating name.
  assert.equal(tag, `instafy-ci/supabase-postgres:sha256-${"a".repeat(64)}`);
  assert.throws(() => cacheTagFor("public.ecr.aws/supabase/postgres:15.1"));
  assert.throws(() => cacheTagFor("public.ecr.aws/supabase/postgres@sha256:short"));
});

test("pinned image pulls retry with bounded exponential backoff", () => {
  const image = `public.ecr.aws/supabase/postgres@sha256:${"b".repeat(64)}`;
  const calls = [];
  const waits = [];
  const statuses = [1, 1, 0];
  const result = pullPinnedImage(image, {
    docker: "fake-docker",
    attempts: statuses.length,
    backoffBaseMs: 25,
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      return { status: statuses.shift(), stderr: "rate limited" };
    },
    waitFor(milliseconds) {
      waits.push(milliseconds);
    },
    logger: { log() {}, warn() {} },
  });

  assert.equal(result, image);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    Array.from({ length: 3 }, () => ["fake-docker", "pull", image]),
  );
  assert.ok(calls.every(({ options }) => options.timeout === 600_000));
  assert.deepEqual(waits, [25, 50]);
});

test("pinned image pulls fail after the configured attempt budget", () => {
  const image = `public.ecr.aws/supabase/postgres@sha256:${"c".repeat(64)}`;
  const calls = [];
  const waits = [];

  assert.throws(
    () =>
      pullPinnedImage(image, {
        attempts: 3,
        backoffBaseMs: 10,
        runCommand(command, args) {
          calls.push([command, ...args]);
          return { status: 1, stderr: `rate limit ${calls.length}` };
        },
        waitFor(milliseconds) {
          waits.push(milliseconds);
        },
        logger: { log() {}, warn() {} },
      }),
    /after 3 attempts: rate limit 3/u,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [10, 20]);
});
