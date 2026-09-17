#!/usr/bin/env node
// Pure authorization of a mobile OTA release tag. The tag is the ledger: it
// names the exact protected-main commit whose web layer is signed and
// published. Every fact from GitHub arrives as input, so this is offline
// testable; the workflow gathers the facts with `gh api` and passes them in.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "instafy-dev/instafy";
export const RELEASE_ACTOR = "instafy-bot";
export const TAG_PATTERN = /^ota-v([0-9a-f]{12})$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ACCEPTED_COMPARE = new Set(["identical", "ahead"]);

function fail(message) {
  throw new Error(message);
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a 40-character lowercase commit sha`);
  }
  return value;
}

/**
 * @param {object} input
 * @param {string} input.eventName push | workflow_dispatch
 * @param {string} input.repository github.repository
 * @param {string} input.actor github.actor
 * @param {string} [input.pusher] github.event.pusher.name (push only)
 * @param {string} input.ref github.ref
 * @param {string} input.githubSha github.sha
 * @param {string} [input.refName] github.ref_name (push)
 * @param {string} [input.inputTag] inputs.tag (dispatch)
 * @param {string} [input.inputDryRun] inputs.dry_run (dispatch)
 * @param {string} [input.tagSha] peeled commit of refs/tags/<tag>, empty when absent
 * @param {string} input.compareStatus compare/<source>...main status
 * @param {string} [input.headSha] git rev-parse HEAD of the checked-out source
 */
export function verifyReleaseTag(input) {
  const eventName = String(input.eventName ?? "");
  if (input.repository !== REPOSITORY) {
    fail(`OTA releases publish only from ${REPOSITORY}`);
  }
  // github.actor survives a re-run; triggering_actor is who started this attempt.
  if (input.actor !== RELEASE_ACTOR || input.triggeringActor !== RELEASE_ACTOR) {
    fail(`OTA releases may only be started by ${RELEASE_ACTOR}`);
  }
  const githubSha = requireSha(input.githubSha, "github.sha");

  let tag;
  let mode;
  if (eventName === "push") {
    if (input.pusher !== RELEASE_ACTOR) {
      fail(`OTA release tags may only be pushed by ${RELEASE_ACTOR}`);
    }
    tag = String(input.refName ?? "");
    if (input.ref !== `refs/tags/${tag}`) {
      fail("A push release must be triggered by the tag ref itself");
    }
    mode = "release";
  } else if (eventName === "workflow_dispatch") {
    if (input.ref !== "refs/heads/main") {
      fail("An OTA release dispatch must run main's workflow (--ref main)");
    }
    tag = String(input.inputTag ?? "").trim();
    const dryRun = String(input.inputDryRun ?? "");
    if (dryRun !== "true" && dryRun !== "false") {
      fail("dry_run must be true or false");
    }
    mode = dryRun === "true" ? "dry_run" : "release";
  } else {
    fail(`Unsupported release trigger: ${eventName || "(none)"}`);
  }

  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    fail("The OTA release tag must match ota-v<first 12 hex of the commit>");
  }

  const tagSha = String(input.tagSha ?? "");
  let sourceSha;
  if (tagSha) {
    sourceSha = requireSha(tagSha, "The peeled tag commit");
  } else if (mode === "dry_run") {
    sourceSha = githubSha;
  } else {
    fail(`Tag ${tag} does not exist; only a dry run may name a tag that is not pushed yet`);
  }
  if (eventName === "push" && sourceSha !== githubSha) {
    fail("The pushed tag no longer resolves to the commit this run was triggered for");
  }
  if (!sourceSha.startsWith(match[1])) {
    fail(`Tag ${tag} does not name its commit ${sourceSha}`);
  }
  if (!ACCEPTED_COMPARE.has(input.compareStatus)) {
    fail("The release commit is not contained in protected main (compare must be identical or ahead)");
  }
  if (input.headSha !== undefined && input.headSha !== sourceSha) {
    fail("The checked-out source is not the release commit");
  }

  return { tag, mode, sourceSha, sourceSha12: sourceSha.slice(0, 12) };
}

export function outputLines(result) {
  return [
    `tag=${result.tag}`,
    `mode=${result.mode}`,
    `source_sha=${result.sourceSha}`,
    `source_sha12=${result.sourceSha12}`,
  ].join("\n");
}

function main() {
  const env = process.env;
  const result = verifyReleaseTag({
    eventName: env.EVENT_NAME,
    repository: env.REPOSITORY,
    actor: env.ACTOR,
    triggeringActor: env.TRIGGERING_ACTOR,
    pusher: env.PUSHER,
    ref: env.REF,
    githubSha: env.RUN_SHA,
    refName: env.REF_NAME,
    inputTag: env.INPUT_TAG,
    inputDryRun: env.INPUT_DRY_RUN,
    tagSha: env.TAG_SHA,
    compareStatus: env.COMPARE_STATUS,
    headSha: env.HEAD_SHA,
  });
  const lines = `${outputLines(result)}\n`;
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, lines);
  }
  process.stdout.write(lines);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
