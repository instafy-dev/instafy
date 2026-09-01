#!/usr/bin/env node
// Makes the pinned Supabase Postgres image present locally without depending
// on ECR Public being willing to serve it right now.
//
// public.ecr.aws rate-limits anonymous pulls per source IP, and GitHub-hosted
// runners share IP pools -- so the migration test's implicit `docker run` pull
// failed intermittently in CI (four times in one week) on rate limits that no
// retry inside a single run can wait out. Order of preference here:
//
//   1. the image is already in the local docker daemon (a restored cache was
//      loaded on a previous step, or a warm self-hosted runner has it),
//   2. a cached tarball exists -> `docker load` it, no network at all,
//   3. pull with exponential backoff, then `docker save` a tarball so the
//      cache step after this one can persist it for the next run.
//
// The image reference is read from the migration test script rather than
// duplicated: that file's digest pin is already guarded by
// test-supabase-migrations-empty-db.test.mjs, and two copies of a digest is
// how one silently goes stale.

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SCRIPT = path.join(MODULE_DIR, "test-supabase-migrations-empty-db.mjs");
const CACHE_DIR =
  process.env.INSTAFY_POSTGRES_IMAGE_CACHE_DIR ||
  path.join(process.env.HOME || ".", ".instafy-image-cache");
const CACHE_TAR = path.join(CACHE_DIR, "supabase-postgres.tar");
const PULL_ATTEMPTS = 5;
const PULL_BACKOFF_BASE_MS = 5_000;

/**
 * The local handle for the cached image. `docker save` does not preserve
 * registry digests, so a loaded image is NOT addressable as `name@sha256:...`
 * -- RepoDigests are only recorded by registry pulls. The tarball therefore
 * carries this digest-derived tag instead, applied immediately after a
 * successful pull *by digest*, which is what keeps the pin honest: the tag
 * can only ever name bytes that were verified against the digest.
 */
export function cacheTagFor(image) {
  const digest = image.split("@")[1];
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest ?? "")) {
    throw new Error(`not a digest-pinned image reference: ${image}`);
  }
  return `instafy-ci/supabase-postgres:${digest.replace(":", "-")}`;
}

/** Extract the digest-pinned image reference from the migration script source. */
export function resolvePinnedPostgresImage(source) {
  const match = source.match(
    /"(public\.ecr\.aws\/supabase\/postgres@sha256:[0-9a-f]{64})"/u,
  );
  if (!match) {
    throw new Error(
      "could not find a digest-pinned Supabase Postgres image reference in the migration test script",
    );
  }
  return match[1];
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function wait(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

export function pullPinnedImage(
  image,
  {
    docker = "docker",
    attempts = PULL_ATTEMPTS,
    backoffBaseMs = PULL_BACKOFF_BASE_MS,
    runCommand = run,
    waitFor = wait,
    logger = console,
  } = {},
) {
  cacheTagFor(image);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("pull attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(backoffBaseMs) || backoffBaseMs < 0) {
    throw new Error("pull backoff must be a non-negative integer");
  }

  let lastDetail = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger.log(`Pulling pinned Postgres image (attempt ${attempt}/${attempts})...`);
    const pull = runCommand(docker, ["pull", image], { timeout: 600_000 });
    if (!pull.error && pull.status === 0) {
      return image;
    }
    lastDetail = String(
      pull.stderr || pull.stdout || pull.error?.message || "",
    )
      .trim()
      .slice(-400);
    if (attempt < attempts) {
      const backoff = backoffBaseMs * 2 ** (attempt - 1);
      logger.warn(`Pull failed; retrying in ${backoff / 1000}s.`);
      waitFor(backoff);
    }
  }
  throw new Error(
    `failed to pull ${image} after ${attempts} attempts${lastDetail ? `: ${lastDetail}` : ""}`,
  );
}

function main() {
  const image = resolvePinnedPostgresImage(readFileSync(MIGRATION_SCRIPT, "utf8"));
  const docker = process.env.DOCKER || "docker";

  if (run(docker, ["image", "inspect", image]).status === 0) {
    console.log("Pinned Postgres image already present locally.");
    return;
  }

  const cacheTag = cacheTagFor(image);
  if (run(docker, ["image", "inspect", cacheTag]).status === 0) {
    console.log("Pinned Postgres image already present locally (cache tag).");
    return;
  }

  if (existsSync(CACHE_TAR)) {
    console.log("Loading pinned Postgres image from cache tarball...");
    const load = run(docker, ["load", "--input", CACHE_TAR]);
    if (load.status === 0 && run(docker, ["image", "inspect", cacheTag]).status === 0) {
      console.log("Loaded from cache; no registry contact needed.");
      return;
    }
    // A truncated or stale tarball must not fail the build: fall through to
    // the pull and overwrite it below.
    console.warn("Cache tarball did not yield the pinned image; falling back to pull.");
  }

  pullPinnedImage(image, { docker });
  const tag = run(docker, ["tag", image, cacheTag]);
  if (tag.status !== 0) {
    throw new Error(`failed to apply cache tag ${cacheTag}`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log("Saving image tarball for the cache step...");
  const save = run(docker, ["save", "--output", CACHE_TAR, cacheTag], {
    timeout: 600_000,
  });
  if (save.status !== 0) {
    // The build only needs the image in the daemon; a failed save just
    // means the next run pulls again.
    console.warn("docker save failed; continuing without refreshing the cache.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
