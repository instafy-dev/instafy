#!/usr/bin/env node
// Writes the secret-free release-receipt.json attached to the Desktop GitHub
// Release (instafy-client-release-receipt-v1). The private release train GETs
// it to verify publication, so the shape is validated before anything is
// written and any value that looks like credential material is refused.
//
// Usage: node write-receipt.mjs <artifact file>...   (configuration via env)

import { createHash } from "node:crypto";
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseReleaseTag } from "./verify-release-tag.mjs";

export const RECEIPT_KIND = "instafy-client-release-receipt-v1";
export const RECEIPT_FILE_NAME = "release-receipt.json";
const REPOSITORY = "instafy-dev/instafy";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const RUN_NUMBER = /^[1-9]\d{0,15}$/u;
// Prefixes are assembled so this file does not itself carry token markers.
const SECRET_MARKERS = Object.freeze([
  "BEGIN ",
  ["sb", "secret", ""].join("_"),
  ["github", "pat", ""].join("_"),
  ["gh", "p_"].join(""),
  "eyJ",
]);

export class ReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReceiptError";
  }
}

function fail(message) {
  throw new ReceiptError(message);
}

export function findSecretLikeValue(value, trail = "receipt") {
  if (typeof value === "string") {
    const marker = SECRET_MARKERS.find((candidate) => value.includes(candidate));
    return marker ? trail : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretLikeValue(item, `${trail}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const found = findSecretLikeValue(item, `${trail}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

function parseRunNumber(raw, name) {
  if (typeof raw !== "string" || !RUN_NUMBER.test(raw)) {
    fail(`${name} must be a positive integer.`);
  }
  return Number(raw);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must have exactly: ${expected.join(", ")}.`);
  }
}

export function validateDesktopReceipt(receipt) {
  exactKeys(
    receipt,
    ["schemaVersion", "kind", "lane", "repository", "tag", "sourceSha", "workflowRef", "version", "destination", "artifacts", "run", "publishedAt"],
    "receipt",
  );
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND) fail("Unsupported receipt schema.");
  if (receipt.lane !== "desktop" || receipt.repository !== REPOSITORY) fail("Receipt lane or repository is wrong.");
  const { version } = parseReleaseTag(receipt.tag);
  if (!FULL_SHA.test(receipt.sourceSha)) fail("sourceSha must be a full lowercase commit SHA.");
  if (
    typeof receipt.workflowRef !== "string" ||
    !receipt.workflowRef.startsWith(`${REPOSITORY}/.github/workflows/desktop-release.yml@refs/`)
  ) {
    fail("workflowRef must name this repository's desktop-release.yml.");
  }
  exactKeys(receipt.version, ["semver"], "version");
  if (receipt.version.semver !== version) fail("version.semver must equal the tag version.");

  const destination = receipt.destination;
  exactKeys(
    destination,
    ["type", "feedUrl", "latestJsonUrl", "immutableBaseUrl", "previousStableVersion", "canary"],
    "destination",
  );
  if (destination.type !== "downloads-r2") fail("destination.type must be downloads-r2.");
  const base = destination.latestJsonUrl?.replace(/\/latest\.json$/u, "");
  if (
    typeof destination.latestJsonUrl !== "string" ||
    !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._-]+\/latest\.json$/u.test(destination.latestJsonUrl) ||
    destination.feedUrl !== `${base}/stable` ||
    destination.immutableBaseUrl !== `${base}/${receipt.tag}`
  ) {
    fail("destination URLs must share one https downloads prefix.");
  }
  if (destination.previousStableVersion !== null && !SEMVER.test(destination.previousStableVersion)) {
    fail("previousStableVersion must be SemVer or null.");
  }
  if (!["launch-smoke", "personal-browser"].includes(destination.canary)) {
    fail("destination.canary must be launch-smoke or personal-browser.");
  }

  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) fail("artifacts must be a non-empty list.");
  const names = new Set();
  for (const artifact of receipt.artifacts) {
    exactKeys(artifact, ["name", "sha256", "sizeBytes"], "artifact");
    if (!SAFE_NAME.test(artifact.name) || artifact.name === RECEIPT_FILE_NAME || names.has(artifact.name)) {
      fail("artifact names must be unique safe file names other than the receipt.");
    }
    names.add(artifact.name);
    if (!SHA256.test(artifact.sha256)) fail("artifact sha256 must be 64 lowercase hex.");
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) fail("artifact sizeBytes must be an integer.");
  }

  exactKeys(receipt.run, ["id", "attempt", "url"], "run");
  if (!Number.isSafeInteger(receipt.run.id) || receipt.run.id <= 0) fail("run.id must be a positive integer.");
  if (!Number.isSafeInteger(receipt.run.attempt) || receipt.run.attempt <= 0) fail("run.attempt must be a positive integer.");
  if (receipt.run.url !== `https://github.com/${REPOSITORY}/actions/runs/${receipt.run.id}/attempts/${receipt.run.attempt}`) {
    fail("run.url must name this run attempt.");
  }
  if (!PUBLISHED_AT.test(receipt.publishedAt) || Number.isNaN(Date.parse(receipt.publishedAt))) {
    fail("publishedAt must be ISO-8601 UTC with second precision.");
  }
  const secretPath = findSecretLikeValue(receipt);
  if (secretPath) fail(`Refusing to write a receipt value that looks like a secret (${secretPath}).`);
  return receipt;
}

export function describeArtifact(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) fail(`${path.basename(filePath)} must be a regular file.`);
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { name: path.basename(filePath), sha256: hash.digest("hex"), sizeBytes: stat.size };
}

export function buildDesktopReceipt(input) {
  const { version } = parseReleaseTag(input.tag);
  const base = `${String(input.downloadsBaseUrl ?? "").replace(/\/+$/u, "")}/${input.downloadsPrefix}`;
  const runId = parseRunNumber(input.runId, "GITHUB_RUN_ID");
  const attempt = parseRunNumber(input.runAttempt, "GITHUB_RUN_ATTEMPT");
  const publishedAt = input.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const receipt = {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    lane: "desktop",
    repository: REPOSITORY,
    tag: input.tag,
    sourceSha: input.sourceSha,
    workflowRef: input.workflowRef,
    version: { semver: version },
    destination: {
      type: "downloads-r2",
      feedUrl: `${base}/stable`,
      latestJsonUrl: `${base}/latest.json`,
      immutableBaseUrl: `${base}/${input.tag}`,
      previousStableVersion: input.previousStableVersion ? input.previousStableVersion : null,
      canary: input.canary,
    },
    artifacts: input.artifacts,
    run: {
      id: runId,
      attempt,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`,
    },
    publishedAt,
  };
  return validateDesktopReceipt(receipt);
}

export function main(argv, env) {
  if (argv.length === 0) fail("Usage: write-receipt.mjs <artifact file>...");
  if (!env.RECEIPT_PATH || path.basename(env.RECEIPT_PATH) !== RECEIPT_FILE_NAME) {
    fail(`RECEIPT_PATH must end in ${RECEIPT_FILE_NAME}.`);
  }
  const receipt = buildDesktopReceipt({
    tag: env.TAG,
    sourceSha: env.SOURCE_SHA,
    workflowRef: env.WORKFLOW_REF,
    downloadsBaseUrl: env.DOWNLOADS_BASE_URL,
    downloadsPrefix: env.DESKTOP_DOWNLOADS_PREFIX,
    previousStableVersion: env.PREVIOUS_STABLE_VERSION,
    canary: env.CANARY_MODE,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    publishedAt: env.PUBLISHED_AT || undefined,
    artifacts: argv.map(describeArtifact),
  });
  fs.writeFileSync(env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return receipt;
}

function isEntryPoint(argvPath) {
  // Compare real paths: temp and checkout roots may sit behind symlinks.
  try {
    return Boolean(argvPath) && realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    const receipt = main(process.argv.slice(2), process.env);
    console.log(`Wrote ${RECEIPT_FILE_NAME} for ${receipt.tag} with ${receipt.artifacts.length} artifacts.`);
  } catch (error) {
    console.error(`::error::${error instanceof ReceiptError ? error.message : "Could not write the release receipt."}`);
    process.exitCode = 1;
  }
}
