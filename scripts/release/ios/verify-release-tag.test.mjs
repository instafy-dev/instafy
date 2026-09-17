import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { authorizeRelease, parseIosTag, peelTagRef, recheckRelease } from "./verify-release-tag.mjs";

const SHA = "a".repeat(40);
const MAIN = "b".repeat(40);
const TAG = "ios-v1.0-81";
const push = {
  repository: "instafy-dev/instafy",
  eventName: "push",
  actor: "instafy-bot",
  pusher: "instafy-bot",
  ref: `refs/tags/${TAG}`,
  sha: SHA,
  tag: TAG,
  dryRun: "",
  reconcileOnly: "",
  tagSha: SHA,
  compareStatus: "ahead",
  releaseState: "absent",
  sourceSha: SHA,
  versions: { name: "1.0", code: "81" },
};
const dispatch = { ...push, eventName: "workflow_dispatch", pusher: "", ref: "refs/heads/main", sha: MAIN, dryRun: "false" };

test("parses only ios-v<marketing>-<build> tags", () => {
  assert.deepEqual(parseIosTag("ios-v1.0-81"), { marketing: "1.0", build: "81" });
  assert.deepEqual(parseIosTag("ios-v2.10.3.4-260860839"), { marketing: "2.10.3.4", build: "260860839" });
  for (const bad of ["ios-v1-81", "ios-v1.0-081", "ios-v1.0-0", "ios-v1.0-81-rc1", "v1.0-81", "ios-v1.0.0.0.0-1", " ios-v1.0-81"]) {
    assert.throws(() => parseIosTag(bad), /must match/u, bad);
  }
});

test("peels lightweight and annotated tags", () => {
  assert.equal(peelTagRef(TAG, null, null), null);
  assert.equal(peelTagRef(TAG, { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } }, null), SHA);
  const annotated = { ref: `refs/tags/${TAG}`, object: { type: "tag", sha: MAIN } };
  assert.equal(peelTagRef(TAG, annotated, { sha: MAIN, object: { type: "commit", sha: SHA } }), SHA);
  assert.throws(() => peelTagRef(TAG, annotated, { sha: MAIN, object: { type: "tag", sha: SHA } }), /peel directly/u);
  assert.throws(() => peelTagRef(TAG, { ref: "refs/tags/other", object: { type: "commit", sha: SHA } }, null), /not exact/u);
});

test("authorizes a bot-pushed tag on main whose version matches the source", () => {
  assert.deepEqual(authorizeRelease(push), {
    tag: TAG,
    mode: "release",
    source_sha: SHA,
    marketing: "1.0",
    build: "81",
    reconcile_only: "false",
    tag_exists: "true",
  });
  assert.equal(authorizeRelease({ ...push, compareStatus: "identical" }).mode, "release");
});

test("rejects foreign actors, repositories, refs, diverged commits and version drift", () => {
  const cases = [
    [{ actor: "someone" }, /actor must be instafy-bot/u],
    [{ pusher: "someone" }, /pusher must be instafy-bot/u],
    [{ repository: "fork/instafy" }, /releases run only/u],
    [{ ref: "refs/heads/main" }, /push ref must be the release tag/u],
    [{ tagSha: MAIN }, /does not resolve to the workflow commit/u],
    [{ tagSha: null }, /no longer resolves/u],
    [{ compareStatus: "behind" }, /not contained in protected main/u],
    [{ compareStatus: "diverged" }, /not contained in protected main/u],
    [{ versions: { name: "1.0", code: "82" } }, /differs from the committed/u],
    [{ versions: { name: "1.1", code: "81" } }, /differs from the committed/u],
    [{ releaseState: "present" }, /Release already exists/u],
    [{ eventName: "pull_request" }, /only tag pushes and workflow_dispatch/u],
    [{ eventName: "pull_request_target" }, /only tag pushes and workflow_dispatch/u],
    [{ reconcileOnly: "true" }, /take no dispatch inputs/u],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => authorizeRelease({ ...push, ...override }), expected, JSON.stringify(override));
  }
});

test("dispatch semantics: dry runs may precede the tag, releases need a new existing tag", () => {
  const dryRunNoTag = authorizeRelease({ ...dispatch, dryRun: "true", tagSha: null, sourceSha: MAIN, releaseState: "absent" });
  assert.equal(dryRunNoTag.mode, "dry_run");
  assert.equal(dryRunNoTag.source_sha, MAIN);
  assert.equal(dryRunNoTag.tag_exists, "false");
  // A dry run ignores an existing Release (no publication happens).
  assert.equal(authorizeRelease({ ...dispatch, dryRun: "true", releaseState: "present" }).source_sha, SHA);
  assert.equal(authorizeRelease(dispatch).mode, "release");
  assert.equal(authorizeRelease({ ...dispatch, reconcileOnly: "true" }).reconcile_only, "true");
  assert.throws(() => authorizeRelease({ ...dispatch, tagSha: null, sourceSha: MAIN }), /requires an existing tag/u);
  assert.throws(() => authorizeRelease({ ...dispatch, dryRun: "true", reconcileOnly: "true" }), /reconcile_only is valid only/u);
  assert.throws(() => authorizeRelease({ ...dispatch, ref: "refs/heads/feature" }), /refs\/heads\/main/u);
  assert.throws(() => authorizeRelease({ ...dispatch, dryRun: "" }), /requires dry_run/u);
  assert.throws(() => authorizeRelease({ ...dispatch, sourceSha: MAIN }), /does not match the tag/u);
});

test("recheck requires the same commit, containment and an absent Release", () => {
  const base = { tag: TAG, sourceSha: SHA, tagSha: SHA, compareStatus: "ahead", releaseState: "absent" };
  assert.equal(recheckRelease(base).recheck, "ok");
  assert.throws(() => recheckRelease({ ...base, tagSha: MAIN }), /no longer resolves/u);
  assert.throws(() => recheckRelease({ ...base, compareStatus: "diverged" }), /no longer contained/u);
  assert.throws(() => recheckRelease({ ...base, releaseState: "present" }), /already exists/u);
});

test("CLI writes GITHUB_OUTPUT from recorded GitHub state and the checked-out pbxproj", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-release-tag-"));
  try {
    const root = path.join(dir, "root");
    const projectDir = path.join(root, "packages/frontend/ios/App/App.xcodeproj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "project.pbxproj"), "MARKETING_VERSION = 1.0;\nCURRENT_PROJECT_VERSION = 81;\nPRODUCT_BUNDLE_IDENTIFIER = dev.instafy.studio;\n");
    const state = path.join(dir, "state");
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, "tag-ref.json"), JSON.stringify({ ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } }));
    fs.writeFileSync(path.join(state, "compare-status.txt"), "identical\n");
    fs.writeFileSync(path.join(state, "release-state.txt"), "absent\n");
    const output = path.join(dir, "output");
    const env = {
      PATH: process.env.PATH,
      RELEASE_STATE_DIR: state,
      RELEASE_TAG: TAG,
      GITHUB_REPOSITORY: "instafy-dev/instafy",
      GITHUB_EVENT_NAME: "push",
      GITHUB_ACTOR: "instafy-bot",
      EVENT_PUSHER: "instafy-bot",
      GITHUB_REF: `refs/tags/${TAG}`,
      GITHUB_SHA: SHA,
      SOURCE_SHA: SHA,
      SOURCE_ROOT: root,
      GITHUB_OUTPUT: output,
    };
    const script = new URL("./verify-release-tag.mjs", import.meta.url).pathname;
    const ok = spawnSync(process.execPath, [script, "authorize"], { env, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(fs.readFileSync(output, "utf8"), /^tag=ios-v1\.0-81\nmode=release\nsource_sha=a{40}\nmarketing=1\.0\nbuild=81\n/u);
    const bad = spawnSync(process.execPath, [script, "authorize"], { env: { ...env, GITHUB_ACTOR: "someone" }, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^::error::\[ios-release-tag\] actor must be instafy-bot/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
