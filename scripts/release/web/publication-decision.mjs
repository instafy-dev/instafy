#!/usr/bin/env node
// Decides, immediately before the Cloudflare Pages mutation, whether this run
// deploys, is already served, or must refuse. Every fact arrives through env so
// the decision is offline-testable; the workflow gathers the facts.
//
// env: SOURCE_SHA, RELEASE_ID, SERVED_RELEASE_ID (may be empty),
//      PREVIOUS_DEPLOYMENT_ID, PREVIOUS_COMMIT_HASH (may be empty),
//      PREVIOUS_COMPARE (identical|ahead|behind|diverged|not-found|none):
//      GitHub compare/<PREVIOUS_COMMIT_HASH>...<SOURCE_SHA> status, "not-found"
//      when the previous hash is not a commit of this repository, "none" when
//      the previous deployment carries no commit hash.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const RELEASE = /^[0-9a-f]{64}$/u;
const DEPLOYMENT = /^[0-9a-f-]{36}$/u;
const COMPARE = new Set(["identical", "ahead", "behind", "diverged", "not-found", "none"]);

function fail(message) {
  throw new Error(message);
}

export function decidePublication(input) {
  if (!SHA.test(input.sourceSha ?? "")) fail("SOURCE_SHA must be a 40-character lowercase sha");
  if (!RELEASE.test(input.releaseId ?? "")) fail("RELEASE_ID must be a sha256 hex digest");
  if (!DEPLOYMENT.test(input.previousDeploymentId ?? "")) fail("Cloudflare did not return the current production deployment");
  const served = String(input.servedReleaseId ?? "");
  if (served && !RELEASE.test(served)) fail("Production serves malformed release metadata");
  if (!COMPARE.has(input.previousCompare)) fail("The previous deployment comparison is unknown");
  const previousCommit = String(input.previousCommitHash ?? "");
  if (input.previousCompare === "none" ? previousCommit !== "" : !SHA.test(previousCommit)) {
    fail("The previous deployment commit hash is malformed");
  }

  if (served === input.releaseId) {
    return { action: "already-serving", previousDeploymentId: input.previousDeploymentId };
  }
  // compare/<previous>...<source>: "ahead" means the release commit is newer.
  if (input.previousCompare === "behind" || input.previousCompare === "diverged") {
    fail(`Production was deployed from a newer or unrelated commit (${input.previousCompare}); refusing a stale publish`);
  }
  // identical: the same commit redeployed (for example after a dashboard
  // rollback); not-found/none: the previous deployment predates this lane.
  return { action: "deploy", previousDeploymentId: input.previousDeploymentId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const env = process.env;
    const decision = decidePublication({
      sourceSha: env.SOURCE_SHA,
      releaseId: env.RELEASE_ID,
      servedReleaseId: env.SERVED_RELEASE_ID,
      previousDeploymentId: env.PREVIOUS_DEPLOYMENT_ID,
      previousCommitHash: env.PREVIOUS_COMMIT_HASH,
      previousCompare: env.PREVIOUS_COMPARE,
    });
    const lines = `action=${decision.action}\nprevious_deployment_id=${decision.previousDeploymentId}\n`;
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines);
    process.stdout.write(lines);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
