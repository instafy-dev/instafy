#!/usr/bin/env node
// Pure authorization of an iOS release run. The tag is the ledger: it must be
// bot-created, peel to a commit contained in protected main, and encode exactly
// the MARKETING_VERSION / CURRENT_PROJECT_VERSION committed at that commit.
//
//   node verify-release-tag.mjs authorize   (authorize job, after checkout)
//   node verify-release-tag.mjs recheck     (immediately before a mutable write)
//
// Inputs come from the environment (see readContext); GitHub API bodies are read
// from files written by github-release-state.sh. Outputs are GITHUB_OUTPUT lines.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readIosVersions } from "./mobile-versions.mjs";

export const REPOSITORY = "instafy-dev/instafy";
export const BOT_LOGIN = "instafy-bot";
export const TAG_PATTERN = /^ios-v([0-9]+(?:\.[0-9]+){1,3})-([1-9][0-9]*)$/u;
const SHA = /^[0-9a-f]{40}$/u;
const CONTAINED_STATUSES = new Set(["identical", "ahead"]);

function fail(message) {
  throw new Error(`[ios-release-tag] ${message}`);
}

export function parseIosTag(tag) {
  const match = typeof tag === "string" ? TAG_PATTERN.exec(tag) : null;
  if (!match) fail("tag must match ios-v<MARKETING_VERSION>-<CURRENT_PROJECT_VERSION>");
  return { marketing: match[1], build: match[2] };
}

export function peelTagRef(tag, refDocument, tagObjectDocument) {
  if (refDocument === null) return null;
  const object = refDocument?.object;
  if (
    refDocument?.ref !== `refs/tags/${tag}` ||
    typeof object?.sha !== "string" ||
    !SHA.test(object.sha)
  ) {
    fail("tag reference response is not exact");
  }
  if (object.type === "commit") return object.sha;
  if (object.type !== "tag") fail("tag reference must point to a commit or an annotated tag");
  const target = tagObjectDocument?.object;
  if (
    tagObjectDocument?.sha !== object.sha ||
    target?.type !== "commit" ||
    typeof target?.sha !== "string" ||
    !SHA.test(target.sha)
  ) {
    fail("annotated tag must peel directly to a commit");
  }
  return target.sha;
}

function booleanInput(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(`${label} must be a boolean`);
}

// On a re-run GitHub keeps github.actor (the original bot actor) and names the
// person who clicked re-run only in github.triggering_actor, so both must be the bot.
export function requireBotTrigger(triggeringActor) {
  if (triggeringActor !== BOT_LOGIN) fail(`triggering actor (including re-runs) must be ${BOT_LOGIN}`);
}

export function authorizeRelease(context) {
  const {
    repository,
    eventName,
    actor,
    triggeringActor,
    pusher,
    ref,
    sha,
    tag,
    dryRun: rawDryRun,
    reconcileOnly: rawReconcileOnly,
    tagSha,
    compareStatus,
    releaseState,
    sourceSha,
    versions,
  } = context;
  if (repository !== REPOSITORY) fail(`releases run only in ${REPOSITORY}`);
  if (actor !== BOT_LOGIN) fail(`actor must be ${BOT_LOGIN}`);
  requireBotTrigger(triggeringActor);
  if (typeof sha !== "string" || !SHA.test(sha)) fail("workflow commit is invalid");
  const { marketing, build } = parseIosTag(tag);
  const dryRun = booleanInput(rawDryRun, "dry_run");
  const reconcileOnly = booleanInput(rawReconcileOnly, "reconcile_only") ?? false;
  if (tagSha !== null && (typeof tagSha !== "string" || !SHA.test(tagSha))) {
    fail("peeled tag commit is invalid");
  }

  let mode;
  let expectedSource;
  if (eventName === "push") {
    if (pusher !== BOT_LOGIN) fail(`tag pusher must be ${BOT_LOGIN}`);
    if (ref !== `refs/tags/${tag}`) fail("push ref must be the release tag");
    if (dryRun !== null || reconcileOnly) fail("push runs take no dispatch inputs");
    if (tagSha === null) fail("pushed tag no longer resolves");
    if (tagSha !== sha) fail("pushed tag does not resolve to the workflow commit");
    mode = "release";
    expectedSource = tagSha;
  } else if (eventName === "workflow_dispatch") {
    if (ref !== "refs/heads/main") fail("dispatch must run the workflow from refs/heads/main");
    if (dryRun === null) fail("dispatch requires dry_run");
    if (dryRun) {
      if (reconcileOnly) fail("reconcile_only is valid only with dry_run=false");
      mode = "dry_run";
      expectedSource = tagSha ?? sha;
    } else {
      if (tagSha === null) fail("a release dispatch requires an existing tag");
      mode = "release";
      expectedSource = tagSha;
    }
  } else {
    fail("only tag pushes and workflow_dispatch may run a release");
  }
  if (sourceSha !== expectedSource) fail("resolved source commit does not match the tag");
  if (!CONTAINED_STATUSES.has(compareStatus)) {
    fail("source commit is not contained in protected main");
  }
  if (mode === "release" && releaseState !== "absent") {
    fail("a GitHub Release already exists for this tag; publish a new version under a new tag");
  }
  if (!versions || versions.name !== marketing || versions.code !== build) {
    fail(
      `tag version ${marketing} (${build}) differs from the committed ` +
        `${versions?.name} (${versions?.code})`,
    );
  }
  return {
    tag,
    mode,
    source_sha: expectedSource,
    marketing,
    build,
    reconcile_only: String(reconcileOnly),
    tag_exists: String(tagSha !== null),
  };
}

export function recheckRelease({ tag, triggeringActor, sourceSha, tagSha, compareStatus, releaseState }) {
  requireBotTrigger(triggeringActor);
  parseIosTag(tag);
  if (typeof sourceSha !== "string" || !SHA.test(sourceSha)) fail("source commit is invalid");
  if (tagSha !== sourceSha) fail("tag no longer resolves to the authorized source commit");
  if (!CONTAINED_STATUSES.has(compareStatus)) {
    fail("source commit is no longer contained in protected main");
  }
  if (releaseState !== "absent") fail("a GitHub Release already exists for this tag");
  return { tag, source_sha: sourceSha, recheck: "ok" };
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail("GitHub API response is not JSON");
  }
}

function readState(directory) {
  const text = (name) => {
    const filePath = path.join(directory, name);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
  };
  return {
    ref: readOptionalJson(path.join(directory, "tag-ref.json")),
    tagObject: readOptionalJson(path.join(directory, "tag-object.json")),
    compareStatus: text("compare-status.txt"),
    releaseState: text("release-state.txt"),
  };
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/u.test(String(value))) fail("output value must be a single line");
    return `${key}=${value}`;
  });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main(argv) {
  const command = argv[0];
  const env = process.env;
  const stateDirectory = env.RELEASE_STATE_DIR;
  if (!stateDirectory) fail("RELEASE_STATE_DIR is required");
  const state = readState(stateDirectory);
  const tag = env.RELEASE_TAG ?? "";
  const tagSha = peelTagRef(tag, state.ref, state.tagObject);
  if (command === "authorize" && argv.length === 1) {
    return authorizeRelease({
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      actor: env.GITHUB_ACTOR,
      triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      pusher: env.EVENT_PUSHER ?? "",
      ref: env.GITHUB_REF,
      sha: env.GITHUB_SHA,
      tag,
      dryRun: env.INPUT_DRY_RUN ?? "",
      reconcileOnly: env.INPUT_RECONCILE_ONLY ?? "",
      tagSha,
      compareStatus: state.compareStatus,
      releaseState: state.releaseState,
      sourceSha: env.SOURCE_SHA,
      versions: readIosVersions(env.SOURCE_ROOT ?? "."),
    });
  }
  if (command === "recheck" && argv.length === 1) {
    return recheckRelease({
      tag,
      triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      sourceSha: env.SOURCE_SHA,
      tagSha,
      compareStatus: state.compareStatus,
      releaseState: state.releaseState,
    });
  }
  fail("usage: verify-release-tag.mjs authorize|recheck");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    writeOutputs(main(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error && /^\[ios-(release-tag|versions)\]/u.test(error.message)
      ? error.message
      : "[ios-release-tag] verification failed";
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  }
}
