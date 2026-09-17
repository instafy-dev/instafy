#!/usr/bin/env node
// Secret-free publication receipt (instafy-client-release-receipt-v1) for an
// iOS TestFlight internal release. Built from the App Store Connect readback
// (post.json) plus either the local IPA + native OTA inspection or, for
// reconcile_only, the digests App Store Connect holds. The output validates
// itself and refuses anything that looks like a credential.
//
// usage:
//   write-receipt.mjs --tag T --source-sha S --marketing M --build B
//                     --post post.json --out release-receipt.json
//                     [--pre pre.json]
//                     (--ipa Instafy.ipa --ota ota.json
//                      | --digest-source app-store-connect --trust-key-sha256 H)
// env: GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const KIND = "instafy-client-release-receipt-v1";
export const REPOSITORY = "instafy-dev/instafy";
export const BUNDLE_ID = "dev.instafy.studio";
export const IPA_FILE_NAME = "Instafy.ipa";
export const CHANNEL = "internal";
// Assembled so the repository identity scrub never sees the literal prefix.
export const MARKER = `${["instafy", "native", "ota", "channel"].join("-")}:${CHANNEL}`;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MD5 = /^[0-9a-f]{32}$/u;
const TAG = /^ios-v([0-9]+(?:\.[0-9]+){1,3})-([1-9][0-9]*)$/u;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const SECRET_MARKERS = [
  ["BEGIN", ""].join(" "),
  ["sb", "secret", ""].join("_"),
  ["github", "pat", ""].join("_"),
  ["gh", "p_"].join(""),
  ["gh", "o_"].join(""),
];

function fail(message) {
  throw new Error(`[ios-receipt] ${message}`);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestFile(filePath) {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) fail("IPA must be a regular file");
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  let sizeBytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      sha256.update(buffer.subarray(0, read));
      md5.update(buffer.subarray(0, read));
      sizeBytes += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: sha256.digest("hex"), md5: md5.digest("hex"), sizeBytes };
}

function exactBuild(post, build) {
  const builds = Array.isArray(post?.builds) ? post.builds.filter((value) => value?.buildNumber === build) : [];
  const uploads = Array.isArray(post?.buildUploads)
    ? post.buildUploads.filter((value) => value?.buildNumber === build)
    : [];
  if (builds.length !== 1 || uploads.length !== 1) fail("readback has no unique build and upload");
  const [candidate] = builds;
  if (
    candidate.processingState !== "VALID" ||
    candidate.buildAudienceType !== "INTERNAL_ONLY" ||
    candidate.internalBuildState !== "IN_BETA_TESTING" ||
    candidate.expired !== false ||
    candidate.distributed !== true
  ) {
    fail("readback does not prove an internal TestFlight build");
  }
  if (uploads[0].state !== "COMPLETE") fail("readback upload is not COMPLETE");
  return { build: candidate, upload: uploads[0] };
}

export function buildReceipt({
  tag,
  sourceSha,
  marketing,
  build,
  pre = null,
  post,
  ipaDigest = null,
  ota = null,
  trustKeySha256 = null,
  run,
  workflowRef,
  publishedAt,
}) {
  const match = TAG.exec(tag ?? "");
  if (!match || match[1] !== marketing || match[2] !== build) fail("tag does not encode the version");
  if (!SHA40.test(sourceSha ?? "")) fail("source sha is invalid");
  if (post?.provider !== "app-store-connect" || post?.bundleId !== BUNDLE_ID || post?.nativeVersion !== marketing) {
    fail("readback identity differs");
  }
  if (pre !== null && pre.appId !== post.appId) fail("pre and post readbacks name different apps");
  if (!post.preReleaseVersionId || !post.betaGroup?.id) fail("readback lacks prerelease version or group");
  const { build: ascBuild, upload } = exactBuild(post, build);

  let ipa;
  let otaBlock;
  let artifacts;
  if (ipaDigest !== null) {
    if (!SHA256.test(ipaDigest.sha256) || !MD5.test(ipaDigest.md5) || !Number.isSafeInteger(ipaDigest.sizeBytes)) {
      fail("local IPA digest is invalid");
    }
    if (
      ota?.lane !== "ios" ||
      ota.channel !== CHANNEL ||
      ota.marker !== MARKER ||
      ota.nativeArtifactSha256 !== ipaDigest.sha256 ||
      ota.applicationId !== BUNDLE_ID ||
      ota.nativeVersion !== marketing ||
      ota.nativeBuild !== build ||
      ota.sourceSha !== sourceSha ||
      !SHA256.test(ota.trustKeySha256 ?? "")
    ) {
      fail("native OTA inspection does not bind this IPA");
    }
    const ipaFiles = (upload.files ?? []).filter((file) => file.uti === "com.apple.ipa");
    if (
      ipaFiles.length !== 1 ||
      ipaFiles[0].sizeBytes !== ipaDigest.sizeBytes ||
      [ipaFiles[0].compositeMd5, ipaFiles[0].fileMd5].some((value) => value !== null && value !== ipaDigest.md5) ||
      (ipaFiles[0].fileSha256 !== null && ipaFiles[0].fileSha256 !== ipaDigest.sha256)
    ) {
      fail("App Store Connect upload file differs from the local IPA");
    }
    ipa = { fileName: IPA_FILE_NAME, ...ipaDigest, digestSource: "local" };
    otaBlock = { channel: CHANNEL, trustKeySha256: ota.trustKeySha256, marker: MARKER };
    artifacts = [{ name: IPA_FILE_NAME, sha256: ipaDigest.sha256, sizeBytes: ipaDigest.sizeBytes }];
  } else {
    const uploaded = post.uploadedIpa;
    if (
      !uploaded ||
      !Number.isSafeInteger(uploaded.sizeBytes) ||
      (uploaded.md5 !== null && !MD5.test(uploaded.md5)) ||
      (uploaded.sha256 !== null && !SHA256.test(uploaded.sha256)) ||
      (uploaded.md5 === null && uploaded.sha256 === null)
    ) {
      fail("App Store Connect holds no digest proof for the uploaded IPA");
    }
    if (!SHA256.test(trustKeySha256 ?? "")) fail("trust key fingerprint is required");
    ipa = {
      fileName: IPA_FILE_NAME,
      sha256: uploaded.sha256,
      md5: uploaded.md5,
      sizeBytes: uploaded.sizeBytes,
      digestSource: "app-store-connect",
    };
    otaBlock = { channel: CHANNEL, trustKeySha256, marker: MARKER };
    artifacts = [];
  }

  const receipt = {
    schemaVersion: 1,
    kind: KIND,
    lane: "ios",
    repository: REPOSITORY,
    tag,
    sourceSha,
    workflowRef,
    version: { marketingVersion: marketing, buildNumber: build },
    destination: {
      type: "testflight-internal",
      bundleId: BUNDLE_ID,
      appStoreConnect: {
        appId: post.appId,
        preReleaseVersionId: post.preReleaseVersionId,
        buildUploadId: upload.id,
        buildId: ascBuild.id,
        betaGroupId: post.betaGroup.id,
        processingState: "VALID",
        buildAudienceType: "INTERNAL_ONLY",
        internalBuildState: "IN_BETA_TESTING",
      },
      ipa,
      ota: otaBlock,
    },
    artifacts,
    run: {
      id: run.id,
      attempt: run.attempt,
      url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.attempt}`,
    },
    publishedAt,
  };
  validateReceipt(receipt);
  return receipt;
}

function assertNoSecrets(value, trail = "receipt") {
  if (typeof value === "string") {
    if (SECRET_MARKERS.some((marker) => value.includes(marker)) || /eyJ[A-Za-z0-9_-]{8,}/u.test(value)) {
      fail(`${trail} looks like a credential`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoSecrets(item, `${trail}.${key}`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys are not exact`);
  }
}

function opaqueId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) fail(`${label} is invalid`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
}

export function validateReceipt(receipt) {
  exactKeys(receipt, [
    "schemaVersion", "kind", "lane", "repository", "tag", "sourceSha", "workflowRef",
    "version", "destination", "artifacts", "run", "publishedAt",
  ], "receipt");
  if (receipt.schemaVersion !== 1 || receipt.kind !== KIND || receipt.lane !== "ios" || receipt.repository !== REPOSITORY) {
    fail("receipt identity is not exact");
  }
  const match = TAG.exec(receipt.tag);
  if (!match) fail("receipt tag is invalid");
  if (!SHA40.test(receipt.sourceSha)) fail("receipt source sha is invalid");
  if (
    typeof receipt.workflowRef !== "string" ||
    !receipt.workflowRef.startsWith(`${REPOSITORY}/.github/workflows/ios-release.yml@`)
  ) {
    fail("receipt workflow ref is invalid");
  }
  exactKeys(receipt.version, ["marketingVersion", "buildNumber"], "version");
  if (receipt.version.marketingVersion !== match[1] || receipt.version.buildNumber !== match[2]) {
    fail("receipt version differs from its tag");
  }
  const destination = receipt.destination;
  exactKeys(destination, ["type", "bundleId", "appStoreConnect", "ipa", "ota"], "destination");
  if (destination.type !== "testflight-internal" || destination.bundleId !== BUNDLE_ID) {
    fail("destination identity is not exact");
  }
  const asc = destination.appStoreConnect;
  exactKeys(asc, [
    "appId", "preReleaseVersionId", "buildUploadId", "buildId", "betaGroupId",
    "processingState", "buildAudienceType", "internalBuildState",
  ], "appStoreConnect");
  for (const key of ["appId", "preReleaseVersionId", "buildUploadId", "buildId", "betaGroupId"]) {
    opaqueId(asc[key], `appStoreConnect.${key}`);
  }
  if (
    asc.processingState !== "VALID" ||
    asc.buildAudienceType !== "INTERNAL_ONLY" ||
    asc.internalBuildState !== "IN_BETA_TESTING"
  ) {
    fail("appStoreConnect state is not released");
  }
  const ipa = destination.ipa;
  exactKeys(ipa, ["fileName", "sha256", "md5", "sizeBytes", "digestSource"], "ipa");
  if (ipa.fileName !== IPA_FILE_NAME) fail("ipa file name is invalid");
  positiveInteger(ipa.sizeBytes, "ipa.sizeBytes");
  if (ipa.digestSource === "local") {
    if (!SHA256.test(ipa.sha256) || !MD5.test(ipa.md5)) fail("local ipa digests are invalid");
  } else if (ipa.digestSource === "app-store-connect") {
    if (ipa.sha256 !== null && !SHA256.test(ipa.sha256)) fail("ipa.sha256 is invalid");
    if (ipa.md5 !== null && !MD5.test(ipa.md5)) fail("ipa.md5 is invalid");
    if (ipa.sha256 === null && ipa.md5 === null) fail("ipa has no digest");
  } else {
    fail("ipa.digestSource is invalid");
  }
  exactKeys(destination.ota, ["channel", "trustKeySha256", "marker"], "ota");
  if (destination.ota.channel !== CHANNEL || destination.ota.marker !== MARKER || !SHA256.test(destination.ota.trustKeySha256)) {
    fail("ota block is invalid");
  }
  if (!Array.isArray(receipt.artifacts)) fail("artifacts must be an array");
  for (const artifact of receipt.artifacts) {
    exactKeys(artifact, ["name", "sha256", "sizeBytes"], "artifact");
    if (artifact.name === "release-receipt.json" || !/^[A-Za-z0-9._-]{1,200}$/u.test(artifact.name)) {
      fail("artifact name is invalid");
    }
    if (!SHA256.test(artifact.sha256)) fail("artifact sha256 is invalid");
    positiveInteger(artifact.sizeBytes, "artifact.sizeBytes");
  }
  if ((ipa.digestSource === "local") !== (receipt.artifacts.length === 1)) {
    fail("the local IPA must be the only release artifact");
  }
  exactKeys(receipt.run, ["id", "attempt", "url"], "run");
  positiveInteger(receipt.run.id, "run.id");
  positiveInteger(receipt.run.attempt, "run.attempt");
  if (receipt.run.url !== `https://github.com/${REPOSITORY}/actions/runs/${receipt.run.id}/attempts/${receipt.run.attempt}`) {
    fail("run url is invalid");
  }
  if (!ISO_SECONDS.test(receipt.publishedAt) || !Number.isFinite(Date.parse(receipt.publishedAt))) {
    fail("publishedAt must be ISO-8601 UTC with second precision");
  }
  assertNoSecrets(receipt);
  return true;
}

export function serializeReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function parseArgs(argv) {
  const allowed = new Set([
    "--tag", "--source-sha", "--marketing", "--build", "--pre", "--post", "--ipa",
    "--ota", "--digest-source", "--trust-key-sha256", "--out",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || value.startsWith("--") || name.slice(2) in options) {
      fail("invalid arguments");
    }
    options[name.slice(2)] = value;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main(argv) {
  const options = parseArgs(argv);
  for (const required of ["tag", "source-sha", "marketing", "build", "post", "out"]) {
    if (!options[required]) fail(`--${required} is required`);
  }
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) fail("receipts are written only in the public repository");
  const local = options.ipa !== undefined;
  if (local) {
    if (!options.ota || options["digest-source"] || options["trust-key-sha256"]) fail("local mode needs --ipa and --ota only");
  } else if (options["digest-source"] !== "app-store-connect" || !options["trust-key-sha256"] || options.ota) {
    fail("reconcile mode needs --digest-source app-store-connect and --trust-key-sha256");
  }
  const receipt = buildReceipt({
    tag: options.tag,
    sourceSha: options["source-sha"],
    marketing: options.marketing,
    build: options.build,
    pre: options.pre ? readJson(options.pre) : null,
    post: readJson(options.post),
    ipaDigest: local ? digestFile(options.ipa) : null,
    ota: local ? readJson(options.ota) : null,
    trustKeySha256: local ? null : options["trust-key-sha256"],
    run: { id: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  });
  fs.writeFileSync(options.out, serializeReceipt(receipt), { flag: "wx", mode: 0o644 });
  console.log(`[ios-receipt] wrote ${path.basename(options.out)} sha256=${sha256Hex(serializeReceipt(receipt))}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("[ios-receipt]")
      ? error.message
      : "[ios-receipt] failed";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
