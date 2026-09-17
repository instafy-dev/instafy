#!/usr/bin/env node
// Authorization checks for the Desktop release lane.
//
// The workflow does every network read (gh api, curl) and hands the raw
// results to this script, so each rule here is pure and testable offline.
// Phases run in order inside the authorize job:
//   request  - event, actor, pusher, ref and tag shape; decides the mode
//   resolve  - peeled tag commit and its relation to protected main
//   source   - checked-out commit and the version committed in source
//   one-shot - live destination probes (release mode only for the one-shot parts)
// Each phase prints GITHUB_OUTPUT lines on stdout, or fails with ::error.

import fs, { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compareSemver } from "../../create-desktop-release-metadata.mjs";

export const RELEASE_REPOSITORY = "instafy-dev/instafy";
export const RELEASE_BOT = "instafy-bot";
export const TAG_PATTERN = /^desktop-app-v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/u;
export const POINTER_CONTRACT = Object.freeze({
  schemaVersion: 1,
  stableAliases: "immutable-pointer",
});
const FULL_SHA = /^[0-9a-f]{40}$/u;

export class ReleaseAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseAuthorizationError";
  }
}

function deny(message) {
  throw new ReleaseAuthorizationError(message);
}

export function parseReleaseTag(tag) {
  const match = typeof tag === "string" ? TAG_PATTERN.exec(tag) : null;
  if (!match) deny("The release tag must be desktop-app-v<MAJOR.MINOR.PATCH>.");
  return { tag, version: match[1] };
}

export function authorizeRequest(input) {
  if (input.repository !== RELEASE_REPOSITORY) {
    deny(`Desktop releases run only in ${RELEASE_REPOSITORY}.`);
  }
  if (input.actor !== RELEASE_BOT) {
    deny(`Desktop releases must be started by ${RELEASE_BOT}.`);
  }
  let tag;
  let mode;
  if (input.eventName === "push") {
    if (input.pusher !== RELEASE_BOT) {
      deny(`The release tag must be pushed by ${RELEASE_BOT}.`);
    }
    if (typeof input.ref !== "string" || !input.ref.startsWith("refs/tags/")) {
      deny("A push release must be triggered by a tag ref.");
    }
    tag = input.ref.slice("refs/tags/".length);
    mode = "release";
  } else if (input.eventName === "workflow_dispatch") {
    if (input.ref !== "refs/heads/main") {
      deny("A dispatched release must run the workflow from refs/heads/main.");
    }
    tag = input.inputTag;
    if (input.inputDryRun === "true") mode = "dry-run";
    else if (input.inputDryRun === "false") mode = "release";
    else deny("dry_run must be exactly true or false.");
  } else {
    deny("Desktop releases accept only tag pushes and workflow_dispatch.");
  }
  if (!FULL_SHA.test(input.sha ?? "")) deny("The workflow commit is not a full SHA.");
  return { ...parseReleaseTag(tag), mode };
}

export function resolveSource(input) {
  const { tag, mode, eventName, sha } = input;
  let sourceSha;
  if (input.tagRefStatus === "404") {
    if (!(eventName === "workflow_dispatch" && mode === "dry-run")) {
      deny(`${tag} does not exist; only a dry run may name a tag that is not pushed yet.`);
    }
    sourceSha = sha;
  } else if (input.tagRefStatus === "200") {
    let ref;
    try {
      ref = JSON.parse(input.tagRefJson);
    } catch {
      deny("The tag ref response is not JSON.");
    }
    if (ref?.ref !== `refs/tags/${tag}`) deny("The tag ref response names a different ref.");
    const type = ref?.object?.type;
    if (type === "commit") {
      sourceSha = ref.object.sha;
    } else if (type === "tag") {
      if (input.peeledType !== "commit") deny("An annotated release tag must point directly at a commit.");
      sourceSha = input.peeledSha;
    } else {
      deny("The release tag does not point at a commit.");
    }
  } else {
    deny("The tag ref lookup did not return a definite answer.");
  }
  if (!FULL_SHA.test(sourceSha ?? "")) deny("The release source is not a full commit SHA.");
  // Every job checks out github.sha, never a computed ref, so the release
  // source must be exactly the commit this run was triggered for. A dispatch
  // therefore publishes or dry-runs only a tag at the main head it runs from.
  if (sourceSha !== sha) {
    if (eventName === "push") {
      deny("The pushed tag no longer resolves to the commit that triggered this run.");
    }
    deny(`${tag} resolves to ${sourceSha}, not to the main head ${sha} this dispatch runs from; re-run the tag's own push run instead.`);
  }
  if (input.compareBase !== sourceSha) deny("The main comparison was made for a different commit.");
  if (!["identical", "ahead"].includes(input.compareStatus)) {
    deny(`Protected main does not contain ${sourceSha} (compare status: ${input.compareStatus || "unknown"}).`);
  }
  return { sourceSha };
}

export function verifySourceVersion({ sourceSha, headSha, packageJson, version }) {
  if (headSha !== sourceSha) deny("The checkout is not the release source commit.");
  let manifest;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    deny("packages/desktop-app/package.json is not JSON.");
  }
  if (manifest?.name !== "@instafy/desktop-app") deny("Unexpected desktop package manifest.");
  if (manifest.version !== version) {
    deny(`The tag names ${version} but packages/desktop-app/package.json at the source commit is ${manifest.version}.`);
  }
  return { version };
}

function parseJsonBody(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    return deny(`${label} is not JSON.`);
  }
}

export function checkDestination(input) {
  if (input.contractStatus !== "200") deny("The downloads Worker stable-pointer contract is unavailable.");
  const contract = parseJsonBody(input.contractBody, "The stable-pointer contract");
  if (JSON.stringify(contract) !== JSON.stringify(POINTER_CONTRACT)) {
    deny("The downloads Worker does not advertise the immutable stable-pointer contract.");
  }
  if (input.mode !== "release") {
    return { previousStableVersion: "", probes: "skipped (dry run)" };
  }
  if (input.releaseStatus !== "404") {
    deny(`A GitHub Release for ${input.tag} already exists or could not be ruled out.`);
  }
  let previousStableVersion = "";
  if (input.latestStatus === "200") {
    const live = parseJsonBody(input.latestBody, "The live latest.json");
    if (typeof live?.version !== "string") deny("The live latest.json has no version.");
    let order;
    try {
      order = compareSemver(live.version, input.version);
    } catch {
      deny("The live latest.json version is not SemVer.");
    }
    if (order >= 0) {
      deny(`The live stable version ${live.version} is not older than ${input.version}; a tag publishes once.`);
    }
    previousStableVersion = live.version;
  } else if (!["204", "404"].includes(input.latestStatus)) {
    deny(`The live latest.json probe returned ${input.latestStatus || "no status"}.`);
  }
  return { previousStableVersion, probes: "enforced" };
}

function readBody(filePath) {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function outputLines(values) {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

export function runPhase(phase, env) {
  switch (phase) {
    case "request": {
      const result = authorizeRequest({
        repository: env.GITHUB_REPOSITORY,
        eventName: env.GITHUB_EVENT_NAME,
        actor: env.GITHUB_ACTOR,
        pusher: env.PUSHER_NAME,
        ref: env.GITHUB_REF,
        sha: env.GITHUB_SHA,
        inputTag: env.INPUT_TAG,
        inputDryRun: env.INPUT_DRY_RUN,
      });
      return outputLines({ tag: result.tag, mode: result.mode, version: result.version });
    }
    case "resolve": {
      const result = resolveSource({
        tag: env.TAG,
        mode: env.MODE,
        eventName: env.GITHUB_EVENT_NAME,
        sha: env.GITHUB_SHA,
        tagRefStatus: env.TAG_REF_STATUS,
        tagRefJson: readBody(env.TAG_REF_PATH),
        peeledType: env.PEELED_TYPE,
        peeledSha: env.PEELED_SHA,
        compareBase: env.COMPARE_BASE,
        compareStatus: env.COMPARE_STATUS,
      });
      return outputLines({ source_sha: result.sourceSha });
    }
    case "source": {
      const result = verifySourceVersion({
        sourceSha: env.SOURCE_SHA,
        headSha: env.HEAD_SHA,
        packageJson: readBody(env.PACKAGE_JSON_PATH),
        version: env.VERSION,
      });
      return outputLines({ version: result.version });
    }
    case "one-shot": {
      const result = checkDestination({
        mode: env.MODE,
        tag: env.TAG,
        version: env.VERSION,
        contractStatus: env.CONTRACT_STATUS,
        contractBody: readBody(env.CONTRACT_PATH),
        releaseStatus: env.RELEASE_STATUS,
        latestStatus: env.LATEST_STATUS,
        latestBody: readBody(env.LATEST_PATH),
      });
      return outputLines({
        previous_stable_version: result.previousStableVersion,
        probes: result.probes,
      });
    }
    default:
      return deny("Usage: verify-release-tag.mjs request|resolve|source|one-shot");
  }
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
    process.stdout.write(`${runPhase(process.argv[2], process.env)}\n`);
  } catch (error) {
    const message = error instanceof ReleaseAuthorizationError ? error.message : "Release authorization failed.";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
