#!/usr/bin/env node
// Writes the secret-free release-receipt.json attached to the ota-v* GitHub
// Release. The private train GETs it, re-verifies the R2 bytes against it and
// only then registers and activates the payloads it lists.
//
// node scripts/release/ota/write-receipt.mjs \
//   --tag ota-v<sha12> --source-sha <40 hex> --workflow-ref <ref> \
//   --ios-marketing-version 1.0 --ios-build-number 81 \
//   --android-version-name 1.0 --android-version-code 260860839 \
//   --archive <tag.zip> --manifest <tag.manifest.json> \
//   --archive-url <url> --manifest-url <url> \
//   --payload ios=<file> --payload android=<file> \
//   --trust-key-sha256 <hex> --run-id <id> --run-attempt <n> --out <file>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "instafy-dev/instafy";
export const RECEIPT_ASSET = "release-receipt.json";
export const CHANNEL = "internal";
const HEX64 = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const TAG = /^ota-v([0-9a-f]{12})$/u;
// Spelled in pieces so this public source does not itself carry the markers.
const TOKEN_PREFIXES = [["github", "pat", ""].join("_"), ["gh", "p_"].join("")];
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function fail(message) {
  throw new Error(message);
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function assertSecretFree(value, trail = "receipt") {
  if (typeof value === "string") {
    if (
      value.includes("BEGIN ") ||
      value.includes("sb_secret_") ||
      TOKEN_PREFIXES.some((prefix) => value.includes(prefix)) ||
      /(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./u.test(value)
    ) {
      fail(`${trail} looks like a secret and must not be written to a public receipt`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSecretFree(item, `${trail}.${key}`);
    }
  }
}

function requireInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`);
  }
}

function requireHttps(value, label, suffix) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail(`${label} must be a plain HTTPS URL`);
  }
  if (!url.pathname.endsWith(suffix)) {
    fail(`${label} must end with ${suffix}`);
  }
}

export function validateReceipt(receipt) {
  const exactKeys = (object, keys, label) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${label} must be an object`);
    const actual = Object.keys(object).sort().join(",");
    if (actual !== [...keys].sort().join(",")) fail(`${label} has unexpected fields`);
  };
  exactKeys(
    receipt,
    ["schemaVersion", "kind", "lane", "repository", "tag", "sourceSha", "workflowRef", "version", "destination", "artifacts", "run", "publishedAt"],
    "receipt",
  );
  if (receipt.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (receipt.kind !== "instafy-client-release-receipt-v1") fail("unexpected receipt kind");
  if (receipt.lane !== "ota") fail("lane must be ota");
  if (receipt.repository !== REPOSITORY) fail("unexpected repository");
  const tag = TAG.exec(receipt.tag);
  if (!tag) fail("tag must be ota-v<sha12>");
  if (!SHA.test(receipt.sourceSha) || !receipt.sourceSha.startsWith(tag[1])) fail("sourceSha must be the tag commit");
  if (typeof receipt.workflowRef !== "string" || !receipt.workflowRef.startsWith(`${REPOSITORY}/.github/workflows/`)) {
    fail("workflowRef must name a workflow of the public repository");
  }

  const { version } = receipt;
  exactKeys(version, ["bundleVersion", "ios", "android"], "version");
  exactKeys(version.ios, ["marketingVersion", "buildNumber"], "version.ios");
  exactKeys(version.android, ["versionName", "versionCode"], "version.android");
  if (version.bundleVersion !== receipt.tag) fail("version.bundleVersion must be the tag");
  for (const value of [version.ios.marketingVersion, version.ios.buildNumber, version.android.versionName, version.android.versionCode]) {
    if (typeof value !== "string" || !value) fail("native versions must be non-empty strings");
  }

  const d = receipt.destination;
  exactKeys(
    d,
    ["type", "channel", "archiveUrl", "manifestUrl", "archiveSha256", "archiveSizeBytes", "manifestSha256", "signature", "trustKeySha256", "payloads", "activation"],
    "destination",
  );
  if (d.type !== "downloads-r2" || d.channel !== CHANNEL || d.activation !== "private-train") fail("unexpected destination");
  requireHttps(d.archiveUrl, "archiveUrl", `/${receipt.tag}.zip`);
  requireHttps(d.manifestUrl, "manifestUrl", `/${receipt.tag}.manifest.json`);
  for (const key of ["archiveSha256", "manifestSha256", "trustKeySha256"]) {
    if (!HEX64.test(d[key])) fail(`${key} must be 64 lowercase hex`);
  }
  requireInt(d.archiveSizeBytes, "archiveSizeBytes");
  if (typeof d.signature !== "string" || !/^[A-Za-z0-9+/]{40,}={0,2}$/u.test(d.signature)) {
    fail("signature must be base64");
  }
  if (!Array.isArray(d.payloads) || d.payloads.map((p) => p?.platform).join(",") !== "ios,android") {
    fail("payloads must list ios then android");
  }
  for (const payload of d.payloads) {
    exactKeys(payload, ["platform", "releaseId", "assetName", "sha256"], "payload");
    if (payload.releaseId !== `${payload.platform}-${CHANNEL}-${receipt.tag}`) fail("unexpected payload releaseId");
    if (payload.assetName !== `${payload.releaseId}.release.json`) fail("unexpected payload asset name");
    if (!HEX64.test(payload.sha256)) fail("payload sha256 must be 64 lowercase hex");
  }

  const expectedAssets = [
    `${receipt.tag}.zip`,
    `${receipt.tag}.manifest.json`,
    ...d.payloads.map((payload) => payload.assetName),
  ];
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.map((a) => a?.name).join("\n") !== expectedAssets.join("\n")) {
    fail("artifacts must list the archive, manifest and both payloads");
  }
  for (const artifact of receipt.artifacts) {
    exactKeys(artifact, ["name", "sha256", "sizeBytes"], "artifact");
    if (!HEX64.test(artifact.sha256)) fail("artifact sha256 must be 64 lowercase hex");
    requireInt(artifact.sizeBytes, "artifact sizeBytes");
  }
  if (receipt.artifacts[0].sha256 !== d.archiveSha256 || receipt.artifacts[0].sizeBytes !== d.archiveSizeBytes) {
    fail("archive artifact must match the destination archive");
  }
  if (receipt.artifacts[1].sha256 !== d.manifestSha256) fail("manifest artifact must match the destination manifest");
  d.payloads.forEach((payload, index) => {
    if (receipt.artifacts[index + 2].sha256 !== payload.sha256) fail("payload artifact digest mismatch");
  });

  exactKeys(receipt.run, ["id", "attempt", "url"], "run");
  requireInt(receipt.run.id, "run.id");
  requireInt(receipt.run.attempt, "run.attempt");
  if (receipt.run.url !== `https://github.com/${REPOSITORY}/actions/runs/${receipt.run.id}/attempts/${receipt.run.attempt}`) {
    fail("run.url must name the exact run attempt");
  }
  if (!ISO_SECOND.test(receipt.publishedAt) || Number.isNaN(Date.parse(receipt.publishedAt))) {
    fail("publishedAt must be ISO-8601 UTC with second precision");
  }
  assertSecretFree(receipt);
  return receipt;
}

export function buildReceipt(options) {
  const tag = String(options.tag);
  const archive = fs.readFileSync(options.archive);
  const manifestBytes = fs.readFileSync(options.manifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (path.basename(options.archive) !== `${tag}.zip` || path.basename(options.manifest) !== `${tag}.manifest.json`) {
    fail("archive and manifest must be named after the tag");
  }
  if (
    manifest.bundle_version !== tag ||
    manifest.git_sha !== options.sourceSha ||
    manifest.archive_sha256 !== sha256(archive) ||
    manifest.archive_size_bytes !== archive.byteLength
  ) {
    fail("The manifest does not describe this archive and commit");
  }

  const native = {
    ios: { nativeVersion: options.iosMarketingVersion, requiredNativeBuild: options.iosBuildNumber },
    android: { nativeVersion: options.androidVersionName, requiredNativeBuild: options.androidVersionCode },
  };
  const payloads = ["ios", "android"].map((platform) => {
    const file = options.payloads[platform];
    if (!file) fail(`--payload ${platform}=<file> is required`);
    const bytes = fs.readFileSync(file);
    const payload = JSON.parse(bytes.toString("utf8"));
    const releaseId = `${platform}-${CHANNEL}-${tag}`;
    const expected = {
      release_id: releaseId,
      platform,
      channel: CHANNEL,
      bundle_version: tag,
      git_sha: options.sourceSha,
      native_version: native[platform].nativeVersion,
      min_supported_native_version: native[platform].nativeVersion,
      required_native_build: native[platform].requiredNativeBuild,
      artifact_url: options.archiveUrl,
      artifact_sha256: manifest.archive_sha256,
      artifact_size_bytes: manifest.archive_size_bytes,
      artifact_type: "zip",
      signature: manifest.archive_signature,
      rollout_percentage: 100,
      status: "live",
    };
    for (const [key, value] of Object.entries(expected)) {
      if (payload[key] !== value) fail(`${platform} payload field ${key} does not match the release`);
    }
    if (path.basename(file) !== `${releaseId}.release.json`) fail(`${platform} payload file must be ${releaseId}.release.json`);
    return { platform, releaseId, assetName: `${releaseId}.release.json`, sha256: sha256(bytes), sizeBytes: bytes.byteLength };
  });

  const runId = Number(options.runId);
  const runAttempt = Number(options.runAttempt);
  const receipt = {
    schemaVersion: 1,
    kind: "instafy-client-release-receipt-v1",
    lane: "ota",
    repository: REPOSITORY,
    tag,
    sourceSha: options.sourceSha,
    workflowRef: options.workflowRef,
    version: {
      bundleVersion: tag,
      ios: { marketingVersion: options.iosMarketingVersion, buildNumber: options.iosBuildNumber },
      android: { versionName: options.androidVersionName, versionCode: options.androidVersionCode },
    },
    destination: {
      type: "downloads-r2",
      channel: CHANNEL,
      archiveUrl: options.archiveUrl,
      manifestUrl: options.manifestUrl,
      archiveSha256: manifest.archive_sha256,
      archiveSizeBytes: manifest.archive_size_bytes,
      manifestSha256: sha256(manifestBytes),
      signature: manifest.archive_signature,
      trustKeySha256: options.trustKeySha256,
      payloads: payloads.map(({ platform, releaseId, assetName, sha256: digest }) => ({ platform, releaseId, assetName, sha256: digest })),
      activation: "private-train",
    },
    artifacts: [
      { name: `${tag}.zip`, sha256: manifest.archive_sha256, sizeBytes: archive.byteLength },
      { name: `${tag}.manifest.json`, sha256: sha256(manifestBytes), sizeBytes: manifestBytes.byteLength },
      ...payloads.map(({ assetName, sha256: digest, sizeBytes }) => ({ name: assetName, sha256: digest, sizeBytes })),
    ],
    run: {
      id: runId,
      attempt: runAttempt,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`,
    },
    publishedAt: options.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
  return validateReceipt(receipt);
}

export function parseArguments(argv) {
  const names = {
    "--tag": "tag",
    "--source-sha": "sourceSha",
    "--workflow-ref": "workflowRef",
    "--ios-marketing-version": "iosMarketingVersion",
    "--ios-build-number": "iosBuildNumber",
    "--android-version-name": "androidVersionName",
    "--android-version-code": "androidVersionCode",
    "--archive": "archive",
    "--manifest": "manifest",
    "--archive-url": "archiveUrl",
    "--manifest-url": "manifestUrl",
    "--trust-key-sha256": "trustKeySha256",
    "--run-id": "runId",
    "--run-attempt": "runAttempt",
    "--published-at": "publishedAt",
    "--out": "out",
  };
  const options = { payloads: {} };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) fail(`${flag} requires a value`);
    if (flag === "--payload") {
      const match = /^(ios|android)=(.+)$/u.exec(value);
      if (!match || options.payloads[match[1]]) fail("--payload must be ios=<file> or android=<file>, once each");
      options.payloads[match[1]] = match[2];
    } else if (names[flag] && options[names[flag]] === undefined) {
      options[names[flag]] = value;
    } else {
      fail(`Unknown or repeated argument ${flag}`);
    }
  }
  for (const required of Object.values(names).filter((name) => name !== "publishedAt")) {
    if (options[required] === undefined) fail(`Missing required argument for ${required}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (path.basename(options.out) !== RECEIPT_ASSET) fail(`--out must be named ${RECEIPT_ASSET}`);
    const receipt = buildReceipt(options);
    fs.writeFileSync(options.out, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(`[mobile-ota-release] Wrote ${RECEIPT_ASSET} for ${receipt.tag}.`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
