#!/usr/bin/env node
// Re-checks, immediately before the Cloudflare Pages mutation, that the release
// tag still peels to SOURCE_SHA and that protected main still contains it.
//
// env: TAG, SOURCE_SHA, GH_TOKEN; reads GitHub through the gh CLI.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { TAG_PATTERN } from "./verify-release-tag.mjs";

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
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) fail("Invalid hosted web tag");
  const body = json(gh([`repos/${REPOSITORY}/git/ref/tags/${tag}`]), "tag");
  if (body.ref !== `refs/tags/${tag}`) fail("GitHub returned a different tag ref");
  let tagSha = body.object?.sha;
  if (body.object?.type === "tag") {
    const annotated = json(gh([`repos/${REPOSITORY}/git/tags/${tagSha}`]), "annotated tag");
    if (annotated.object?.type !== "commit") fail("The annotated tag does not point at a commit");
    tagSha = annotated.object.sha;
  } else if (body.object?.type !== "commit") {
    fail("The tag does not point at a commit");
  }
  const compareStatus = json(gh([`repos/${REPOSITORY}/compare/${tagSha}...main`]), "compare").status;
  return { tagSha, compareStatus };
}

export function assertBound(state, sourceSha) {
  if (state.tagSha !== sourceSha) fail("The release tag no longer resolves to the built commit");
  if (state.compareStatus !== "identical" && state.compareStatus !== "ahead") {
    fail("The release commit is no longer contained in protected main");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertBound(readTagState({ tag: process.env.TAG ?? "" }), process.env.SOURCE_SHA);
    console.log(`[web-release] ${process.env.TAG} still binds ${process.env.SOURCE_SHA} on protected main.`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
