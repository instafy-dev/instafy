#!/usr/bin/env node
// Copies every digest-pinned Docker Hub image the repository's image builds
// pull to ghcr.io/instafy-dev/dockerhub/<path>, preserving each digest, and
// proves each copy is anonymously pullable. Run by
// .github/workflows/mirror-docker-hub-images.yml on protected main only.
//
//   node scripts/mirror-docker-hub-images.mjs plan [--offline]
//   node scripts/mirror-docker-hub-images.mjs mirror
//   node scripts/mirror-docker-hub-images.mjs verify
//
// The image set is discovered from the checkout (scripts/lib/dockerHubImageMirror.mjs);
// there is no lock to keep in sync. plan and verify make only anonymous
// registry reads, and plan --offline makes none. mirror needs a prior
// `docker login ghcr.io`. It runs `docker buildx imagetools create
// --prefer-index=false` with one source and no annotations or platform filter.
// For an index source that republishes the index bytes unchanged together with
// every child manifest; for a single-manifest source --prefer-index=false makes
// it a carbon copy instead of wrapping the manifest in a new index (buildx
// v0.35.0 util/imagetools/create.go). Either way the anonymous check after
// the copy refuses any result whose digest differs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DOCKER_HUB_MIRROR,
  discoverRepositoryImages,
  inspectMirror,
  mirrorTagRef,
  sourceDigestRef,
} from "./lib/dockerHubImageMirror.mjs";
import { commandTail, delay, fetchManifest, readManifestWithBackoff, retryableStatus } from "./lib/registryManifests.mjs";

export const COPY_ATTEMPTS = 3;
// Docker Hub's anonymous limit is per IP and per window, so a 429 needs a
// longer wait than a GHCR hiccup.
export const COPY_BACKOFF_MS = 30_000;
export const COPY_TIMEOUT_MS = 15 * 60_000;
export const VISIBILITY_ATTEMPTS = 6;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function packageSettingsUrl(imagePath) {
  return `https://github.com/orgs/instafy-dev/packages/container/${encodeURIComponent(`dockerhub/${imagePath}`)}/settings`;
}

/**
 * Anonymous reads with the shared backoff on 429, 5xx and network errors. Once
 * one read exhausts that backoff GHCR is having an outage, and the remaining
 * reads are single attempts, so the job fails in minutes instead of at its
 * timeout.
 */
function backoffReader({ read, sleep, log }) {
  let degraded = false;
  return async (reference) => {
    const result = await readManifestWithBackoff(reference, { read, attempts: degraded ? 1 : undefined, sleep, log });
    if (!result.ok && retryableStatus(result.status)) degraded = true;
    return result;
  };
}

/** Which discovered images GHCR does not fully serve anonymously. */
export async function planMirror(images, { read = fetchManifest, sleep = delay, log = console.log } = {}) {
  const readGhcr = backoffReader({ read, sleep, log });
  const present = [];
  const missing = [];
  for (const image of images) {
    const state = await inspectMirror(image, { read: readGhcr });
    if (state.complete) {
      present.push(image);
      continue;
    }
    if (!state.gaps.includes("manifest")) {
      log(`::warning::${image.path}: GHCR serves ${image.digest} but not its ${state.gaps.join(", ")}; copying it again.`);
    }
    missing.push(image);
  }
  return { present, missing };
}

/**
 * Copy each image GHCR lacks from Docker Hub, by digest, then prove anonymously
 * that GHCR serves exactly that digest, its immutable tag and every child
 * manifest. Every image is attempted; the result lists each outcome.
 */
export async function mirrorImages(images, { execute = spawnSync, read = fetchManifest, sleep = delay, log = console.log } = {}) {
  const readGhcr = backoffReader({ read, sleep, log });
  const results = [];
  for (const image of images) {
    const before = await inspectMirror(image, { read: readGhcr });
    if (before.complete) {
      log(`${image.path}@${image.digest}: GHCR already serves it anonymously; skipping the copy.`);
      results.push({ image, state: "present" });
      continue;
    }
    const target = mirrorTagRef(image);
    const source = sourceDigestRef(image);
    let copied = false;
    for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
      log(`${image.path}: copying ${source} to ${target} (attempt ${attempt}/${COPY_ATTEMPTS})...`);
      const result = execute(
        "docker",
        ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", target, source],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: COPY_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      );
      if (result && !result.error && result.status === 0) {
        copied = true;
        break;
      }
      log(`::warning::${image.path}: copy from Docker Hub failed.\n${commandTail(result)}`);
      if (attempt < COPY_ATTEMPTS) await sleep(COPY_BACKOFF_MS * 2 ** (attempt - 1));
    }
    if (!copied) {
      results.push({ image, state: "copy failed" });
      continue;
    }
    // GHCR can expose a new package a few seconds after the write returns.
    let after;
    for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
      after = await inspectMirror(image, { read: readGhcr });
      if (after.complete || attempt === VISIBILITY_ATTEMPTS) break;
      await sleep(1_000 * 2 ** attempt);
    }
    if (after.complete) {
      log(`${image.path}: GHCR serves ${image.digest} as ${target}.`);
      results.push({ image, state: "mirrored" });
    } else {
      log(`::error::${image.path}: after the copy GHCR does not serve its ${after.gaps.join(", ")} anonymously.`);
      results.push({ image, state: "not anonymously served" });
    }
  }
  return results;
}

/** Anonymous proof for every discovered image: manifest, immutable tag and each child manifest. */
export async function verifyMirror(images, { read = fetchManifest, sleep = delay, log = console.log } = {}) {
  const readGhcr = backoffReader({ read, sleep, log });
  const problems = [];
  const rows = [];
  for (const image of images) {
    const state = await inspectMirror(image, { read: readGhcr });
    if (state.complete) {
      rows.push({ image, state: "ok" });
      continue;
    }
    const { manifest } = state;
    if (state.gaps.includes("manifest") && !manifest.ok && (manifest.status === 401 || manifest.status === 403)) {
      // GHCR answers 403 for both a private and an absent package.
      rows.push({ image, state: "not public or missing" });
      problems.push(`${image.path}@${image.digest} is not anonymously pullable (HTTP ${manifest.status}). If the copy step succeeded, set the package visibility to Public: ${packageSettingsUrl(image.path)}`);
    } else {
      rows.push({ image, state: state.gaps.includes("manifest") ? "missing" : "incomplete" });
      problems.push(`${image.path}@${image.digest}: GHCR does not serve its ${state.gaps.join(", ")} anonymously.`);
    }
  }
  return { problems, rows };
}

export function summaryMarkdown(title, rows, { unpinned = [], skipped = [] } = {}) {
  const lines = [
    `### ${title}`,
    "",
    `Mirror: \`${DOCKER_HUB_MIRROR}\`. Builds fall back to Docker Hub for anything missing here.`,
    "",
    "| Image | Mirror tag | Digest | Used by | State |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(({ image, state }) =>
      `| ${image.path} | \`${image.mirrorTag}\` | \`${image.digest.slice(0, 19)}\` | ${image.sources.join("<br>")} | ${state} |`),
    "",
  ];
  if (unpinned.length > 0) {
    lines.push("Docker Hub references without a digest (not mirrored):", "",
      ...unpinned.map((entry) => `- \`${entry.reference}\` in ${entry.source} (${entry.reason})`), "");
  }
  if (skipped.length > 0) {
    lines.push("Other registries (left alone):", "",
      ...skipped.map((entry) => `- \`${entry.reference}\` in ${entry.source}`), "");
  }
  return lines.join("\n");
}

function appendGithubFile(variable, text) {
  const file = process.env[variable];
  if (file) fs.appendFileSync(file, text);
}

function reportDiscovery({ images, unpinned, skipped }) {
  console.log(`Discovered ${images.length} digest-pinned Docker Hub image(s):`);
  for (const image of images) {
    console.log(`  ${image.path}@${image.digest} -> ${mirrorTagRef(image)}`);
    console.log(`    used by ${image.sources.join(", ")}`);
  }
  for (const entry of unpinned) {
    console.log(`::warning::${entry.source}: ${entry.reference} is a Docker Hub reference without a resolvable digest (${entry.reason}); it is not mirrored.`);
  }
  for (const entry of skipped) console.log(`Skipping ${entry.reference} (${entry.registry}) in ${entry.source}.`);
}

async function main(args) {
  const [command, ...rest] = args;
  const discovery = discoverRepositoryImages(root);
  const { images } = discovery;
  if (command === "plan") {
    reportDiscovery(discovery);
    if (rest.includes("--offline")) return;
    const { present, missing } = await planMirror(images);
    console.log(`GHCR already serves ${present.length} of ${images.length} image(s) anonymously; ${missing.length} to copy.`);
    appendGithubFile("GITHUB_OUTPUT", `missing=${missing.length}\n`);
    const rows = images.map((image) => ({ image, state: present.includes(image) ? "present" : "to copy" }));
    appendGithubFile("GITHUB_STEP_SUMMARY", summaryMarkdown("Docker Hub image mirror plan", rows, discovery));
    return;
  }
  if (command === "mirror") {
    const results = await mirrorImages(images);
    appendGithubFile("GITHUB_STEP_SUMMARY", summaryMarkdown("Docker Hub image mirror copy", results));
    const failed = results.filter((result) => !["present", "mirrored"].includes(result.state));
    if (failed.length > 0) {
      throw new Error(`${failed.length} image(s) were not mirrored; builds keep pulling them from Docker Hub until fixed`);
    }
    console.log(`Mirrored or confirmed ${results.length} image(s) in GHCR.`);
    return;
  }
  if (command === "verify") {
    const { problems, rows } = await verifyMirror(images);
    appendGithubFile("GITHUB_STEP_SUMMARY", summaryMarkdown("Docker Hub image mirror (anonymous)", rows));
    for (const problem of problems) console.log(`::error::${problem}`);
    if (problems.length > 0) {
      throw new Error(`${problems.length} mirror problem(s); builds keep falling back to Docker Hub until they are fixed`);
    }
    console.log(`All ${images.length} image(s) are anonymously pullable from GHCR by digest.`);
    return;
  }
  throw new Error("usage: mirror-docker-hub-images.mjs plan [--offline] | mirror | verify");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
