import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cacheTagFor,
  ensurePinnedPostgresImage,
  pullMirroredImage,
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
  // ensure step pulls from ECR every run and the flake returns. Main saves
  // the cache and every other ref restores it, so both steps come first.
  const cacheIndexes = [
    "      - name: Restore Supabase Postgres image cache without saving\n",
    "      - name: Restore Supabase Postgres image cache\n",
  ].map((step) => workflow.indexOf(step));
  const ensureIndex = workflow.indexOf("scripts/ensure-supabase-postgres-image.mjs");
  const migrateIndex = workflow.indexOf(
    "run: node scripts/test-supabase-migrations-empty-db.mjs",
  );
  for (const cacheIndex of cacheIndexes) {
    assert.ok(cacheIndex > -1, "build.yml must restore the postgres image cache");
    assert.ok(cacheIndex < ensureIndex, "cache restore must precede the ensure step");
  }
  assert.ok(ensureIndex > -1, "build.yml must run the ensure script");
  assert.ok(migrateIndex > -1, "build.yml must still run the migration test");
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

test("the GHCR mirror gets one bounded pull of the same digest and never retries", () => {
  const digest = `sha256:${"d".repeat(64)}`;
  const image = `public.ecr.aws/supabase/postgres@${digest}`;
  const calls = [];
  const quiet = { log() {}, warn() {} };
  const pulled = pullMirroredImage(image, {
    docker: "fake-docker",
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    logger: quiet,
  });
  assert.equal(pulled, `ghcr.io/instafy-dev/supabase/postgres@${digest}`);
  assert.deepEqual(calls, [
    { command: "fake-docker", args: ["pull", pulled], options: { timeout: 180_000 } },
  ]);

  calls.length = 0;
  const warnings = [];
  assert.equal(
    pullMirroredImage(image, {
      runCommand(command, args, options) {
        calls.push({ command, args, options });
        return { status: 1, stderr: "denied" };
      },
      logger: { log() {}, warn: (line) => warnings.push(line) },
    }),
    null,
  );
  assert.equal(calls.length, 1);
  assert.match(warnings[0], /falling back to ECR Public/u);
  assert.throws(() => pullMirroredImage("public.ecr.aws/supabase/postgres:17", { runCommand() {} }));
});

function ensureHarness({ present = [], mirror = "ok", tarball = false } = {}) {
  const image = `public.ecr.aws/supabase/postgres@sha256:${"e".repeat(64)}`;
  const events = [];
  const options = {
    image,
    docker: "fake-docker",
    env: { GITHUB_ACTIONS: "true" },
    cacheDir: "/inert-cache",
    cacheTar: "/inert-cache/supabase-postgres.tar",
    runCommand(command, args) {
      events.push(["docker", ...args]);
      if (args[0] === "image") return { status: present.includes(args[2]) ? 0 : 1 };
      return { status: 0 };
    },
    fileExists: () => tarball,
    makeDirectory: () => events.push(["mkdir"]),
    pullMirror(reference, pullOptions) {
      events.push(["mirror", reference, pullOptions.docker]);
      return mirror === "ok" ? `ghcr.io/instafy-dev/supabase/postgres@${reference.split("@")[1]}` : null;
    },
    pullPinned(reference, pullOptions) {
      events.push(["ecr", reference, pullOptions.docker]);
      return reference;
    },
    logger: { log() {}, warn() {} },
  };
  return { image, events, options, cacheTag: cacheTagFor(image) };
}

test("a cold runner pulls the mirror first and caches the digest-bound tag from what it pulled", () => {
  const h = ensureHarness();
  assert.equal(ensurePinnedPostgresImage(h.options), h.cacheTag);
  const mirrorRef = `ghcr.io/instafy-dev/supabase/postgres@${h.image.split("@")[1]}`;
  assert.deepEqual(h.events, [
    ["docker", "image", "inspect", h.image],
    ["docker", "image", "inspect", h.cacheTag],
    ["mirror", h.image, "fake-docker"],
    ["docker", "tag", mirrorRef, h.cacheTag],
    ["mkdir"],
    ["docker", "save", "--output", "/inert-cache/supabase-postgres.tar", h.cacheTag],
  ]);
});

test("a failed mirror pull falls back to the unchanged ECR retry budget", () => {
  const h = ensureHarness({ mirror: "fail" });
  ensurePinnedPostgresImage(h.options);
  assert.deepEqual(h.events.slice(2, 5), [
    ["mirror", h.image, "fake-docker"],
    ["ecr", h.image, "fake-docker"],
    ["docker", "tag", h.image, h.cacheTag],
  ]);
});

test("the mirror follows the shared switch and local images or caches need no registry", () => {
  const off = ensureHarness();
  ensurePinnedPostgresImage({ ...off.options, env: { GITHUB_ACTIONS: "true", SUPABASE_IMAGE_MIRROR: "off" } });
  assert.deepEqual(off.events.filter(([kind]) => kind === "mirror" || kind === "ecr").map(([kind]) => kind), ["ecr"]);
  const local = ensureHarness();
  ensurePinnedPostgresImage({ ...local.options, env: {} });
  assert.deepEqual(local.events.filter(([kind]) => kind === "mirror" || kind === "ecr").map(([kind]) => kind), ["ecr"]);
  for (const present of [[ensureHarness().image], [ensureHarness().cacheTag]]) {
    const cached = ensureHarness({ present });
    ensurePinnedPostgresImage(cached.options);
    assert.ok(cached.events.every(([kind]) => kind === "docker"));
    assert.ok(cached.events.every(([, verb]) => verb === "image"));
  }
  const invalid = ensureHarness();
  assert.throws(
    () => ensurePinnedPostgresImage({ ...invalid.options, env: { SUPABASE_IMAGE_MIRROR: "yes" } }),
    /SUPABASE_IMAGE_MIRROR must be/u,
  );
  assert.deepEqual(invalid.events, []);
});
