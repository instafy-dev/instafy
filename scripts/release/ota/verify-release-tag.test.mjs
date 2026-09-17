import assert from "node:assert/strict";
import test from "node:test";

import { outputLines, verifyReleaseTag } from "./verify-release-tag.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const TAG = "ota-v8ddffed21d44";

const push = (overrides = {}) => ({
  eventName: "push",
  repository: "instafy-dev/instafy",
  actor: "instafy-bot",
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
  ref: "refs/heads/main",
  githubSha: SHA,
  inputTag: TAG,
  inputDryRun: "false",
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
  assert.throws(() => verifyReleaseTag(push({ pusher: "octocat" })), /pushed by instafy-bot/u);
  assert.throws(() => verifyReleaseTag(push({ ref: "refs/heads/main" })), /tag ref itself/u);
});

test("tag format, sha prefix, moved tags and main containment fail closed", () => {
  for (const bad of ["ota-v8DDFFED21D44", "ota-v8ddffed21d4", "ota-internal-v1", "ota-v8ddffed21d44x"]) {
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

test("dispatch must run main's workflow and names the mode explicitly", () => {
  assert.equal(verifyReleaseTag(dispatch()).mode, "release");
  assert.equal(verifyReleaseTag(dispatch({ inputDryRun: "true" })).mode, "dry_run");
  assert.throws(() => verifyReleaseTag(dispatch({ ref: `refs/tags/${TAG}` })), /--ref main/u);
  assert.throws(() => verifyReleaseTag(dispatch({ inputDryRun: "" })), /dry_run must be/u);
  assert.throws(() => verifyReleaseTag(dispatch({ actor: "octocat" })), /started by instafy-bot/u);
  assert.throws(() => verifyReleaseTag({ ...dispatch(), eventName: "pull_request" }), /Unsupported release trigger/u);
});

test("only a dry run may name a tag that does not exist yet", () => {
  const dry = verifyReleaseTag(dispatch({ inputDryRun: "true", tagSha: "" }));
  assert.equal(dry.sourceSha, SHA);
  assert.throws(() => verifyReleaseTag(dispatch({ tagSha: "" })), /does not exist/u);
  assert.throws(
    () => verifyReleaseTag(dispatch({ inputDryRun: "true", tagSha: "", githubSha: OTHER })),
    /does not name its commit/u,
  );
});
