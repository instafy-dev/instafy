import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseAndroidTag, verifyReleaseTag } from "./verify-release-tag.mjs";

const COMMIT = "a".repeat(40);
const MAIN = "b".repeat(40);
const VERSIONS = { applicationId: "dev.instafy.studio", versionName: "1.0", versionCode: "260860839" };
const TAG = "android-v1.0-260860839";

function push(overrides = {}) {
  return {
    eventName: "push",
    repository: "instafy-dev/instafy",
    ref: `refs/tags/${TAG}`,
    sha: COMMIT,
    actor: "instafy-bot",
    pusher: "instafy-bot",
    inputTag: "",
    inputDryRun: "",
    tagState: "present",
    tagCommit: COMMIT,
    sourceSha: COMMIT,
    compareStatus: "ahead",
    headSha: COMMIT,
    versions: VERSIONS,
    ...overrides,
  };
}

function dispatch(overrides = {}) {
  return push({
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    sha: MAIN,
    pusher: "",
    inputTag: TAG,
    inputDryRun: "false",
    ...overrides,
  });
}

test("parses the tag grammar exactly", () => {
  assert.deepEqual(parseAndroidTag("android-v1.0-260860839"), {
    tag: "android-v1.0-260860839",
    versionName: "1.0",
    versionCode: "260860839",
  });
  assert.equal(parseAndroidTag("android-v1.0-rc.1-42").versionName, "1.0-rc.1");
  for (const bad of [
    "android-v1.0-0", "android-v1.0-012", "android-v-1", "ios-v1.0-81",
    "android-v1.0-12345678901", "android-v1.0-2100000001", "refs/tags/android-v1.0-1",
    "android-v1.0 -1", "android-v.1.0-1",
  ]) {
    assert.throws(() => parseAndroidTag(bad), undefined, bad);
  }
});

test("authorizes a bot-pushed tag on main whose version equals the source", () => {
  assert.deepEqual(verifyReleaseTag(push()), {
    tag: TAG,
    mode: "release",
    source_sha: COMMIT,
    version_name: "1.0",
    version_code: "260860839",
  });
  assert.equal(verifyReleaseTag(push({ compareStatus: "identical" })).mode, "release");
});

test("refuses push runs that are not the bot's exact tag on main", () => {
  const cases = [
    [{ repository: "someone/fork" }, /releases run only in/u],
    [{ actor: "octocat" }, /actor must be/u],
    [{ pusher: "octocat" }, /tag pusher must be/u],
    [{ ref: "refs/heads/main" }, /push must be a tag ref/u],
    [{ tagCommit: MAIN }, /peeled tag commit differs/u],
    [{ tagState: "absent", tagCommit: "" }, /no longer resolves/u],
    [{ compareStatus: "behind" }, /not contained in protected main/u],
    [{ compareStatus: "diverged" }, /not contained in protected main/u],
    [{ headSha: MAIN }, /checked-out HEAD differs/u],
    [{ versions: { ...VERSIONS, versionCode: "260860840" } }, /versionCode differs/u],
    [{ versions: { ...VERSIONS, versionName: "1.1" } }, /versionName differs/u],
    [{ versions: { ...VERSIONS, applicationId: "dev.other" } }, /applicationId differs/u],
    [{ eventName: "pull_request_target" }, /only push \(tag\) and workflow_dispatch/u],
  ];
  for (const [overrides, error] of cases) {
    assert.throws(() => verifyReleaseTag(push(overrides)), error, JSON.stringify(overrides));
  }
});

test("dispatch publishes only an existing tag and dry runs may precede the tag", () => {
  assert.equal(verifyReleaseTag(dispatch()).mode, "release");
  assert.throws(
    () => verifyReleaseTag(dispatch({ tagState: "absent", tagCommit: "", sourceSha: MAIN, headSha: MAIN })),
    /requires an existing tag/u,
  );
  const dry = verifyReleaseTag(dispatch({
    inputDryRun: "true",
    tagState: "absent",
    tagCommit: "",
    sourceSha: MAIN,
    headSha: MAIN,
  }));
  assert.equal(dry.mode, "dry_run");
  assert.equal(dry.source_sha, MAIN);
  assert.throws(
    () => verifyReleaseTag(dispatch({ inputDryRun: "true", sourceSha: MAIN, headSha: MAIN })),
    /differs from the peeled tag commit/u,
  );
  assert.throws(() => verifyReleaseTag(dispatch({ ref: "refs/heads/feature" })), /refs\/heads\/main/u);
  assert.throws(() => verifyReleaseTag(dispatch({ actor: "octocat" })), /actor must be/u);
  assert.throws(() => verifyReleaseTag(dispatch({ inputDryRun: "yes" })), /dry_run input/u);
  assert.throws(() => verifyReleaseTag(dispatch({ inputTag: "android-v1.0-1" })), /versionCode differs/u);
});

test("CLI writes GitHub outputs and reports failures as annotations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-tag-"));
  try {
    const versions = path.join(root, "versions.json");
    const output = path.join(root, "output");
    fs.writeFileSync(versions, JSON.stringify(VERSIONS));
    const env = {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "instafy-dev/instafy",
      GITHUB_REF: `refs/tags/${TAG}`,
      GITHUB_SHA: COMMIT,
      GITHUB_ACTOR: "instafy-bot",
      GITHUB_OUTPUT: output,
      PUSHER_NAME: "instafy-bot",
      TAG_STATE: "present",
      TAG_COMMIT: COMMIT,
      SOURCE_SHA: COMMIT,
      COMPARE_STATUS: "identical",
      HEAD_SHA: COMMIT,
      VERSIONS_JSON: versions,
    };
    const script = path.join(import.meta.dirname, "verify-release-tag.mjs");
    const ok = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(fs.readFileSync(output, "utf8"), /^tag=android-v1\.0-260860839\nmode=release\nsource_sha=a{40}\n/u);
    const bad = spawnSync(process.execPath, [script], { env: { ...env, PUSHER_NAME: "octocat" }, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^::error::\[android-release-tag\] tag pusher must be instafy-bot/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
