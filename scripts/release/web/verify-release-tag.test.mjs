import assert from "node:assert/strict";
import test from "node:test";

import { outputLines, verifyReleaseTag } from "./verify-release-tag.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const TAG = "web-v8ddffed21d44";

const push = (overrides = {}) => ({
  eventName: "push",
  repository: "instafy-dev/instafy",
  actor: "instafy-bot",
  triggeringActor: "instafy-bot",
  pusher: "instafy-bot",
  ref: `refs/tags/${TAG}`,
  refName: TAG,
  githubSha: SHA,
  tagSha: SHA,
  compareStatus: "ahead",
  headSha: SHA,
  ...overrides,
});

const dispatch = (overrides = {}) => ({
  eventName: "workflow_dispatch",
  repository: "instafy-dev/instafy",
  actor: "instafy-bot",
  triggeringActor: "instafy-bot",
  ref: "refs/heads/main",
  githubSha: SHA,
  inputTag: TAG,
  tagSha: SHA,
  compareStatus: "identical",
  ...overrides,
});

test("a bot-pushed tag on protected main is a release of its exact commit", () => {
  const result = verifyReleaseTag(push());
  assert.deepEqual(result, { tag: TAG, mode: "release", sourceSha: SHA, sourceSha12: "8ddffed21d44" });
  assert.equal(outputLines(result), `tag=${TAG}\nmode=release\nsource_sha=${SHA}\nsource_sha12=8ddffed21d44`);
});

test("push is refused for another repository, actor, pusher or ref", () => {
  assert.throws(() => verifyReleaseTag(push({ repository: "someone/instafy" })), /publish only from/u);
  assert.throws(() => verifyReleaseTag(push({ actor: "octocat" })), /started by instafy-bot/u);
  assert.throws(() => verifyReleaseTag(push({ triggeringActor: "octocat" })), /started by instafy-bot/u);
  assert.throws(() => verifyReleaseTag(dispatch({ triggeringActor: undefined })), /started by instafy-bot/u);
  assert.throws(() => verifyReleaseTag(push({ pusher: "octocat" })), /pushed by instafy-bot/u);
  assert.throws(() => verifyReleaseTag(push({ ref: "refs/heads/main" })), /tag ref itself/u);
});

test("tag format, sha prefix, moved tags and main containment fail closed", () => {
  for (const bad of ["web-v8DDFFED21D44", "web-v8ddffed21d4", "ota-v8ddffed21d44", "web-v8ddffed21d44x", "web-v8ddffed21d44-r1", "web-v8ddffed21d44-r01", "web-v8ddffed21d44-r100", "web-v8ddffed21d44-r2x"]) {
    assert.throws(() => verifyReleaseTag(push({ refName: bad, ref: `refs/tags/${bad}` })), /must match/u);
  }
  assert.throws(() => verifyReleaseTag(push({ tagSha: OTHER, githubSha: OTHER, headSha: OTHER })), /does not name its commit/u);
  assert.throws(() => verifyReleaseTag(push({ tagSha: OTHER })), /no longer resolves/u);
  for (const status of ["behind", "diverged", "", undefined]) {
    assert.throws(() => verifyReleaseTag(push({ compareStatus: status })), /protected main/u);
  }
  assert.throws(() => verifyReleaseTag(push({ headSha: OTHER })), /checked-out source/u);
  assert.throws(() => verifyReleaseTag(push({ githubSha: "abc" })), /40-character/u);
});

test("dispatch must run main's workflow and is always a dry run of github.sha", () => {
  assert.deepEqual(verifyReleaseTag(dispatch()), { tag: TAG, mode: "dry_run", sourceSha: SHA, sourceSha12: "8ddffed21d44" });
  // A stale inputs.dry_run=false from an older caller cannot turn a dispatch into a publication.
  assert.equal(verifyReleaseTag({ ...dispatch(), inputDryRun: "false" }).mode, "dry_run");
  assert.throws(() => verifyReleaseTag(dispatch({ ref: `refs/tags/${TAG}` })), /--ref main/u);
  assert.throws(() => verifyReleaseTag(dispatch({ actor: "octocat" })), /started by instafy-bot/u);
  assert.throws(() => verifyReleaseTag({ ...dispatch(), eventName: "pull_request" }), /Unsupported release trigger/u);
});

test("the release commit is always github.sha; an existing tag must peel to it", () => {
  const dry = verifyReleaseTag(dispatch({ tagSha: "" }));
  assert.equal(dry.sourceSha, SHA);
  assert.throws(() => verifyReleaseTag(dispatch({ tagSha: OTHER })), /not the main head/u);
  assert.throws(() => verifyReleaseTag(dispatch({ tagSha: "", githubSha: OTHER })), /does not name its commit/u);
  assert.throws(() => verifyReleaseTag(push({ tagSha: "" })), /does not exist/u);
  assert.throws(() => verifyReleaseTag(dispatch({ tagSha: "abc" })), /40-character/u);
  assert.throws(() => verifyReleaseTag(dispatch({ headSha: OTHER })), /checked-out source/u);
});

test("a retry tag -r2..-r99 releases the same commit", () => {
  const retry = "web-v8ddffed21d44-r2";
  assert.equal(verifyReleaseTag(push({ refName: "web-v8ddffed21d44-r99", ref: "refs/tags/web-v8ddffed21d44-r99" })).tag, "web-v8ddffed21d44-r99");
  assert.deepEqual(verifyReleaseTag(push({ refName: retry, ref: `refs/tags/${retry}` })), {
    tag: retry,
    mode: "release",
    sourceSha: SHA,
    sourceSha12: "8ddffed21d44",
  });
});
