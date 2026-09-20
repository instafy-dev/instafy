#!/usr/bin/env node
// Writes the secret-free release-receipt.json (instafy-client-release-receipt-v1,
// lane "android") attached to the GitHub Release of the tag. Every field is
// derived from verified inputs and the output validates itself before print.
//
// usage: write-receipt.mjs --tag <tag> --source-sha <sha> --name <versionName>
//          --code <versionCode> --aab <app-release.aab> --ota <ota.json>
//          --post <post.json> [--published-at <ISO-8601>]
// env:   GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { googleReleaseMatches, validateObservation } from "./google-play-internal.mjs";
import { parseAndroidTag, REPOSITORY } from "./verify-release-tag.mjs";

export const RECEIPT_KIND = "instafy-client-release-receipt-v1";
export const AAB_FILE_NAME = "app-release.aab";
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const WORKFLOW_REF = /^instafy-dev\/instafy\/\.github\/workflows\/android-release\.yml@refs\/(?:tags\/android-v[0-9A-Za-z._-]+|heads\/main)$/u;
// Assembled so repository secret scanners do not flag this detector itself.
const SECRET_MARKERS = ["BEGIN ", "sb_secret_", ["github", "pat_"].join("_"), ["gh", "p_"].join(""), "eyJ"];

function fail(message) {
  throw new Error(`[android-receipt] ${message}`);
}

function exact(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function keys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} keys are not exact`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

export function assertSecretFree(value, pathLabel = "receipt") {
  if (typeof value === "string") {
    for (const marker of SECRET_MARKERS) {
      if (value.includes(marker)) fail(`${pathLabel} looks like a credential`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${pathLabel}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertSecretFree(item, `${pathLabel}.${key}`);
  }
}

export function validateReceipt(receipt) {
  keys(receipt, [
    "schemaVersion", "kind", "lane", "repository", "tag", "sourceSha", "workflowRef",
    "version", "destination", "artifacts", "run", "publishedAt",
  ], "receipt");
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND || receipt.lane !== "android") {
    fail("receipt identity is not exact");
  }
  if (receipt.repository !== REPOSITORY) fail("receipt repository is not exact");
  const parsed = parseAndroidTag(receipt.tag);
  exact(receipt.sourceSha, SHA40, "sourceSha");
  exact(receipt.workflowRef, WORKFLOW_REF, "workflowRef");
  keys(receipt.version, ["versionName", "versionCode"], "version");
  if (receipt.version.versionName !== parsed.versionName || receipt.version.versionCode !== parsed.versionCode) {
    fail("receipt version differs from the tag");
  }
  const destination = keys(receipt.destination, [
    "type", "applicationId", "track", "releaseStatus", "releaseName", "aab", "play", "ota",
  ], "destination");
  if (
    destination.type !== "play-internal" ||
    destination.applicationId !== "dev.instafy.studio" ||
    destination.track !== "internal" ||
    destination.releaseStatus !== "completed" ||
    destination.releaseName !== `${parsed.versionName} (${parsed.versionCode})`
  ) {
    fail("destination is not the exact Play internal release");
  }
  keys(destination.aab, ["fileName", "sha256", "sizeBytes"], "destination.aab");
  if (destination.aab.fileName !== AAB_FILE_NAME) fail("destination.aab.fileName is not exact");
  exact(destination.aab.sha256, SHA256, "destination.aab.sha256");
  positiveInteger(destination.aab.sizeBytes, "destination.aab.sizeBytes");
  keys(destination.play, ["observedAt", "stateSha256"], "destination.play");
  if (Number.isNaN(Date.parse(destination.play.observedAt))) fail("destination.play.observedAt is invalid");
  exact(destination.play.stateSha256, SHA256, "destination.play.stateSha256");
  keys(destination.ota, ["channel", "trustKeySha256"], "destination.ota");
  if (destination.ota.channel !== "internal") fail("destination.ota.channel is not internal");
  exact(destination.ota.trustKeySha256, SHA256, "destination.ota.trustKeySha256");
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== 1) fail("artifacts must list the AAB");
  keys(receipt.artifacts[0], ["name", "sha256", "sizeBytes"], "artifacts[0]");
  if (
    receipt.artifacts[0].name !== AAB_FILE_NAME ||
    receipt.artifacts[0].sha256 !== destination.aab.sha256 ||
    receipt.artifacts[0].sizeBytes !== destination.aab.sizeBytes
  ) {
    fail("artifacts[0] differs from the published AAB");
  }
  keys(receipt.run, ["id", "attempt", "url"], "run");
  positiveInteger(receipt.run.id, "run.id");
  positiveInteger(receipt.run.attempt, "run.attempt");
  if (receipt.run.url !== `https://github.com/${REPOSITORY}/actions/runs/${receipt.run.id}/attempts/${receipt.run.attempt}`) {
    fail("run.url is not exact");
  }
  exact(receipt.publishedAt, ISO_SECOND, "publishedAt");
  assertSecretFree(receipt);
  return receipt;
}

function readJson(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail(`${label} must be a bounded regular file`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${label} is not JSON`);
  }
}

function runNumber(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) fail(`${label} must be a positive integer`);
  return positiveInteger(Number(value), label);
}

export function buildReceipt({ tag, sourceSha, versionName, versionCode, aabPath, ota, post, env, publishedAt }) {
  const parsed = parseAndroidTag(tag);
  if (parsed.versionName !== versionName || parsed.versionCode !== versionCode) fail("version differs from the tag");
  exact(sourceSha, SHA40, "source sha");
  if (path.basename(aabPath) !== AAB_FILE_NAME) fail(`AAB must be named ${AAB_FILE_NAME}`);
  const stat = fs.lstatSync(aabPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) fail("AAB must be a regular non-empty file");
  const bytes = fs.readFileSync(aabPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  keys(ota, [
    "schemaVersion", "applicationId", "versionName", "versionCode", "channel",
    "trustKeySha256", "nativeArtifactSha256", "sourceSha",
  ], "OTA attestation");
  if (
    ota.schemaVersion !== 1 ||
    ota.applicationId !== "dev.instafy.studio" ||
    ota.versionName !== versionName ||
    ota.versionCode !== versionCode ||
    ota.channel !== "internal" ||
    ota.nativeArtifactSha256 !== sha256 ||
    ota.sourceSha !== sourceSha
  ) {
    fail("OTA attestation differs from the published bundle");
  }
  exact(ota.trustKeySha256, SHA256, "OTA trust key digest");

  const observation = validateObservation(post);
  if (!googleReleaseMatches(observation, versionCode, versionName, sha256)) {
    fail("Play observation does not prove the exact internal release");
  }

  const runId = runNumber(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const runAttempt = runNumber(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  if (env.GITHUB_REPOSITORY !== REPOSITORY) fail("GITHUB_REPOSITORY is not exact");
  const receipt = {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    lane: "android",
    repository: REPOSITORY,
    tag,
    sourceSha,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    version: { versionName, versionCode },
    destination: {
      type: "play-internal",
      applicationId: "dev.instafy.studio",
      track: "internal",
      releaseStatus: "completed",
      releaseName: `${versionName} (${versionCode})`,
      aab: { fileName: AAB_FILE_NAME, sha256, sizeBytes: bytes.length },
      play: { observedAt: observation.observedAt, stateSha256: observation.stateSha256 },
      ota: { channel: "internal", trustKeySha256: ota.trustKeySha256 },
    },
    artifacts: [{ name: AAB_FILE_NAME, sha256, sizeBytes: bytes.length }],
    run: {
      id: runId,
      attempt: runAttempt,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`,
    },
    publishedAt: publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
  return validateReceipt(receipt);
}

export function parseArguments(argv) {
  const names = ["--tag", "--source-sha", "--name", "--code", "--aab", "--ota", "--post", "--published-at"];
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.includes(name) || typeof value !== "string" || value === "" || options[name] !== undefined) {
      fail(`usage: write-receipt.mjs ${names.slice(0, 7).map((n) => `${n} <value>`).join(" ")} [--published-at <iso>]`);
    }
    options[name] = value;
  }
  for (const name of names.slice(0, 7)) {
    if (options[name] === undefined) fail(`${name} is required`);
  }
  return options;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const receipt = buildReceipt({
      tag: options["--tag"],
      sourceSha: options["--source-sha"],
      versionName: options["--name"],
      versionCode: options["--code"],
      aabPath: options["--aab"],
      ota: readJson(options["--ota"], "OTA attestation"),
      post: readJson(options["--post"], "Play observation"),
      env: process.env,
      publishedAt: options["--published-at"],
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : "[android-receipt] failed"}\n`);
    process.exitCode = 1;
  }
}
