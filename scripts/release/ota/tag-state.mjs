#!/usr/bin/env node
// Re-checks the one-shot invariants immediately before a mutable write:
// the tag still peels to SOURCE_SHA, protected main still contains it, and no
// GitHub Release exists for it yet (the Release is the last publication step).
//
// env: TAG, SOURCE_SHA, GH_TOKEN; reads GitHub through the gh CLI.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "instafy-dev/instafy";

function fail(message) {
  throw new Error(message);
}

export function ghCli(args) {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error) fail("The gh CLI could not run");
  return { status: result.status, stdout: result.stdout, notFound: /HTTP 404/u.test(result.stderr ?? "") };
}

function json(response, label) {
  if (response.status !== 0) fail(`GitHub lookup failed: ${label}`);
  return JSON.parse(response.stdout);
}

export function readTagState({ tag, gh = ghCli }) {
  if (!/^ota-v[0-9a-f]{12}$/u.test(tag)) fail("Invalid OTA tag");
  const ref = gh([`repos/${REPOSITORY}/git/ref/tags/${tag}`]);
  let tagSha = null;
  if (ref.status === 0) {
    const body = JSON.parse(ref.stdout);
    if (body.ref !== `refs/tags/${tag}`) fail("GitHub returned a different tag ref");
    tagSha = body.object?.sha;
    if (body.object?.type === "tag") {
      const annotated = json(gh([`repos/${REPOSITORY}/git/tags/${tagSha}`]), "annotated tag");
      if (annotated.object?.type !== "commit") fail("The annotated tag does not point at a commit");
      tagSha = annotated.object.sha;
    } else if (body.object?.type !== "commit") {
      fail("The tag does not point at a commit");
    }
  } else if (!ref.notFound) {
    fail("GitHub tag lookup failed");
  }
  let compareStatus = null;
  if (tagSha) {
    compareStatus = json(gh([`repos/${REPOSITORY}/compare/${tagSha}...main`]), "compare").status;
  }
  const release = gh([`repos/${REPOSITORY}/releases/tags/${tag}`]);
  if (release.status !== 0 && !release.notFound) fail("GitHub release lookup failed");
  return { tagSha, compareStatus, releaseExists: release.status === 0 };
}

export function assertUnpublished(state, sourceSha) {
  if (state.tagSha !== sourceSha) fail("The release tag no longer resolves to the built commit");
  if (state.compareStatus !== "identical" && state.compareStatus !== "ahead") {
    fail("The release commit is no longer contained in protected main");
  }
  if (state.releaseExists) fail("A GitHub Release already exists for this tag; publication is one-shot");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertUnpublished(readTagState({ tag: process.env.TAG ?? "" }), process.env.SOURCE_SHA);
    console.log(`[mobile-ota-release] ${process.env.TAG} still binds ${process.env.SOURCE_SHA} and is unpublished.`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
