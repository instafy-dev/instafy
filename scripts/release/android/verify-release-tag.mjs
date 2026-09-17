#!/usr/bin/env node
// Offline authorization of one Android release run. The workflow gathers the
// facts (event, actor, peeled tag commit, compare status, committed versions)
// and this script decides; it performs no network calls and prints no secret.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ANDROID_APPLICATION_ID,
  assertVersionCode,
  assertVersionName,
} from "./mobile-versions.mjs";

export const REPOSITORY = "instafy-dev/instafy";
export const RELEASE_ACTOR = "instafy-bot";
export const TAG_PATTERN = /^android-v([0-9A-Za-z][0-9A-Za-z._-]{0,63})-([1-9][0-9]{0,9})$/u;
const SHA = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(`[android-release-tag] ${message}`);
}

export function parseAndroidTag(tag) {
  const match = typeof tag === "string" ? TAG_PATTERN.exec(tag) : null;
  if (!match) fail("tag must match android-v<versionName>-<versionCode>");
  return {
    tag,
    versionName: assertVersionName(match[1], "tag versionName"),
    versionCode: assertVersionCode(match[2], "tag versionCode"),
  };
}

function sha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} must be a 40-hex commit`);
  return value;
}

export function verifyReleaseTag(facts) {
  const {
    eventName,
    repository,
    ref,
    sha: eventSha,
    actor,
    pusher,
    inputTag,
    inputDryRun,
    tagState,
    tagCommit,
    sourceSha,
    compareStatus,
    headSha,
    versions,
  } = facts ?? {};

  if (repository !== REPOSITORY) fail(`releases run only in ${REPOSITORY}`);
  if (actor !== RELEASE_ACTOR) fail(`actor must be ${RELEASE_ACTOR}`);
  sha(eventSha, "event sha");
  if (!["present", "absent"].includes(tagState)) fail("tag state must be present or absent");
  if (tagState === "present") sha(tagCommit, "peeled tag commit");

  let tag;
  let mode;
  if (eventName === "push") {
    if (typeof ref !== "string" || !ref.startsWith("refs/tags/")) fail("push must be a tag ref");
    tag = ref.slice("refs/tags/".length);
    if (pusher !== RELEASE_ACTOR) fail(`tag pusher must be ${RELEASE_ACTOR}`);
    if (tagState !== "present") fail("pushed tag no longer resolves");
    if (tagCommit !== eventSha) fail("peeled tag commit differs from the pushed commit");
    mode = "release";
  } else if (eventName === "workflow_dispatch") {
    if (ref !== "refs/heads/main") fail("dispatch must run the workflow from refs/heads/main");
    if (inputDryRun !== "true" && inputDryRun !== "false") fail("dry_run input must be true or false");
    tag = inputTag;
    mode = inputDryRun === "true" ? "dry_run" : "release";
    if (mode === "release" && tagState !== "present") fail("a publishing dispatch requires an existing tag");
  } else {
    fail("only push (tag) and workflow_dispatch may run a release");
  }

  const parsed = parseAndroidTag(tag);
  const expectedSource = tagState === "present" ? tagCommit : eventSha;
  if (sha(sourceSha, "source sha") !== expectedSource) {
    fail("source sha differs from the peeled tag commit");
  }
  if (!["identical", "ahead"].includes(compareStatus)) {
    fail("tag commit is not contained in protected main");
  }
  if (headSha !== sourceSha) fail("checked-out HEAD differs from the source sha");

  if (!versions || typeof versions !== "object") fail("committed versions are missing");
  if (versions.applicationId !== ANDROID_APPLICATION_ID) fail("committed applicationId differs");
  if (versions.versionName !== parsed.versionName) {
    fail("tag versionName differs from the committed resolvedVersionName");
  }
  if (versions.versionCode !== parsed.versionCode) {
    fail("tag versionCode differs from the committed resolvedVersionCode");
  }

  return {
    tag: parsed.tag,
    mode,
    source_sha: sourceSha,
    version_name: parsed.versionName,
    version_code: parsed.versionCode,
  };
}

function factsFromEnvironment(env) {
  const versionsPath = env.VERSIONS_JSON ?? "";
  if (!versionsPath) fail("VERSIONS_JSON is required");
  return {
    eventName: env.GITHUB_EVENT_NAME,
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    actor: env.GITHUB_ACTOR,
    pusher: env.PUSHER_NAME ?? "",
    inputTag: env.INPUT_TAG ?? "",
    inputDryRun: env.INPUT_DRY_RUN ?? "",
    tagState: env.TAG_STATE,
    tagCommit: env.TAG_COMMIT ?? "",
    sourceSha: env.SOURCE_SHA,
    compareStatus: env.COMPARE_STATUS,
    headSha: env.HEAD_SHA,
    versions: JSON.parse(fs.readFileSync(versionsPath, "utf8")),
  };
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  try {
    const result = verifyReleaseTag(factsFromEnvironment(process.env));
    const lines = Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join("");
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
    process.stdout.write(lines);
  } catch (error) {
    const message = error instanceof Error ? error.message : "[android-release-tag] failed";
    process.stdout.write(`::error::${message}\n`);
    process.exitCode = 1;
  }
}
