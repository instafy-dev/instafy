import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authorizeRequest,
  checkDestination,
  parseReleaseTag,
  resolveSource,
  verifySourceVersion,
} from "./verify-release-tag.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const OTHER = "62417cbe0000000000000000000000000000beef";
const script = path.join(import.meta.dirname, "verify-release-tag.mjs");

const push = {
  repository: "instafy-dev/instafy",
  eventName: "push",
  actor: "instafy-bot",
  pusher: "instafy-bot",
  ref: "refs/tags/desktop-app-v0.2.13",
  sha: SHA,
};
const dispatch = {
  repository: "instafy-dev/instafy",
  eventName: "workflow_dispatch",
  actor: "instafy-bot",
  ref: "refs/heads/main",
  sha: SHA,
  inputTag: "desktop-app-v0.2.13",
  inputDryRun: "true",
};

test("tag shape is plain SemVer only", () => {
  assert.deepEqual(parseReleaseTag("desktop-app-v0.2.13"), { tag: "desktop-app-v0.2.13", version: "0.2.13" });
  for (const bad of ["desktop-app-v0.2", "desktop-app-v01.2.3", "desktop-app-v1.2.3-beta.1", "desktop-app-v1.2.3+sha", "ios-v1.0-81", "desktop-app-v1.2.3\n"]) {
    assert.throws(() => parseReleaseTag(bad), /MAJOR\.MINOR\.PATCH/u, bad);
  }
});

test("push requires the bot as actor and pusher on a tag ref", () => {
  assert.deepEqual(authorizeRequest(push), { tag: "desktop-app-v0.2.13", version: "0.2.13", mode: "release" });
  assert.throws(() => authorizeRequest({ ...push, actor: "someone" }), /started by instafy-bot/u);
  assert.throws(() => authorizeRequest({ ...push, pusher: "someone" }), /pushed by instafy-bot/u);
  assert.throws(() => authorizeRequest({ ...push, ref: "refs/heads/desktop-app-v0.2.13" }), /tag ref/u);
  assert.throws(() => authorizeRequest({ ...push, repository: "someone/instafy" }), /run only in/u);
  assert.throws(() => authorizeRequest({ ...push, eventName: "pull_request" }), /only tag pushes/u);
});

test("dispatch runs from main and maps dry_run to a mode", () => {
  assert.equal(authorizeRequest(dispatch).mode, "dry-run");
  assert.equal(authorizeRequest({ ...dispatch, inputDryRun: "false" }).mode, "release");
  assert.throws(() => authorizeRequest({ ...dispatch, inputDryRun: "" }), /dry_run/u);
  assert.throws(() => authorizeRequest({ ...dispatch, ref: "refs/heads/feature" }), /refs\/heads\/main/u);
  assert.throws(() => authorizeRequest({ ...dispatch, actor: "someone" }), /instafy-bot/u);
});

const lightweight = JSON.stringify({ ref: "refs/tags/desktop-app-v0.2.13", object: { type: "commit", sha: SHA } });
const resolveBase = {
  tag: "desktop-app-v0.2.13",
  mode: "release",
  eventName: "push",
  sha: SHA,
  tagRefStatus: "200",
  tagRefJson: lightweight,
  compareBase: SHA,
  compareStatus: "ahead",
};

test("resolve peels tags, binds push to github.sha and requires ancestry on main", () => {
  assert.deepEqual(resolveSource(resolveBase), { sourceSha: SHA });
  assert.equal(resolveSource({ ...resolveBase, compareStatus: "identical" }).sourceSha, SHA);
  const annotated = JSON.stringify({ ref: "refs/tags/desktop-app-v0.2.13", object: { type: "tag", sha: OTHER } });
  assert.equal(resolveSource({ ...resolveBase, tagRefJson: annotated, peeledType: "commit", peeledSha: SHA }).sourceSha, SHA);
  assert.throws(() => resolveSource({ ...resolveBase, tagRefJson: annotated, peeledType: "tag", peeledSha: SHA }), /directly at a commit/u);
  assert.throws(() => resolveSource({ ...resolveBase, sha: OTHER, compareBase: SHA }), /no longer resolves/u);
  for (const status of ["behind", "diverged", ""]) {
    assert.throws(() => resolveSource({ ...resolveBase, compareStatus: status }), /does not contain/u);
  }
  assert.throws(() => resolveSource({ ...resolveBase, compareBase: OTHER }), /different commit/u);
  assert.throws(() => resolveSource({ ...resolveBase, tagRefJson: lightweight.replace("0.2.13", "0.2.14") }), /different ref/u);
});

test("a dispatch runs only for a tag at the main head it runs from", () => {
  const dispatched = { ...resolveBase, eventName: "workflow_dispatch" };
  assert.equal(resolveSource(dispatched).sourceSha, SHA);
  assert.equal(resolveSource({ ...dispatched, mode: "dry-run" }).sourceSha, SHA);
  for (const mode of ["release", "dry-run"]) {
    assert.throws(() => resolveSource({ ...dispatched, mode, sha: OTHER }), /not to the main head/u);
  }
});

test("a missing tag is accepted only for a dispatched dry run", () => {
  const missing = { ...resolveBase, tagRefStatus: "404", tagRefJson: "" };
  assert.throws(() => resolveSource(missing), /only a dry run/u);
  assert.throws(() => resolveSource({ ...missing, eventName: "workflow_dispatch" }), /only a dry run/u);
  assert.equal(resolveSource({ ...missing, eventName: "workflow_dispatch", mode: "dry-run" }).sourceSha, SHA);
  assert.throws(() => resolveSource({ ...resolveBase, tagRefStatus: "500" }), /definite answer/u);
});

test("source version must equal the tag version at the exact checkout", () => {
  const packageJson = JSON.stringify({ name: "@instafy/desktop-app", version: "0.2.13" });
  assert.deepEqual(verifySourceVersion({ sourceSha: SHA, headSha: SHA, packageJson, version: "0.2.13" }), { version: "0.2.13" });
  assert.throws(() => verifySourceVersion({ sourceSha: SHA, headSha: OTHER, packageJson, version: "0.2.13" }), /checkout/u);
  assert.throws(() => verifySourceVersion({ sourceSha: SHA, headSha: SHA, packageJson, version: "0.2.14" }), /package\.json at the source commit is 0\.2\.13/u);
});

const contractBody = JSON.stringify({ schemaVersion: 1, stableAliases: "immutable-pointer" });
const destination = {
  mode: "release",
  tag: "desktop-app-v0.2.13",
  version: "0.2.13",
  contractStatus: "200",
  contractBody,
  releaseStatus: "404",
  latestStatus: "200",
  latestBody: JSON.stringify({ version: "0.2.12" }),
};

test("one-shot probes require an older live version and no GitHub Release", () => {
  assert.deepEqual(checkDestination(destination), { previousStableVersion: "0.2.12", probes: "enforced" });
  assert.equal(checkDestination({ ...destination, latestStatus: "204", latestBody: "" }).previousStableVersion, "");
  assert.throws(() => checkDestination({ ...destination, latestBody: JSON.stringify({ version: "0.2.13" }) }), /publishes once/u);
  assert.throws(() => checkDestination({ ...destination, latestBody: JSON.stringify({ version: "0.3.0" }) }), /not older/u);
  assert.throws(() => checkDestination({ ...destination, releaseStatus: "200" }), /already exists/u);
  assert.throws(() => checkDestination({ ...destination, latestStatus: "503" }), /returned 503/u);
});

test("the Worker contract is exact and dry runs skip only the one-shot probes", () => {
  assert.throws(() => checkDestination({ ...destination, contractBody: JSON.stringify({ schemaVersion: 1, stableAliases: "copy" }) }), /stable-pointer contract/u);
  assert.throws(() => checkDestination({ ...destination, contractStatus: "404" }), /unavailable/u);
  const dry = { ...destination, mode: "dry-run", releaseStatus: "200", latestBody: JSON.stringify({ version: "9.9.9" }) };
  assert.equal(checkDestination(dry).probes, "skipped (dry run)");
  assert.throws(() => checkDestination({ ...dry, contractBody: "{}" }), /stable-pointer contract/u);
});

test("CLI prints GITHUB_OUTPUT lines and fails with an annotation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-verify-tag-"));
  try {
    const env = {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: "instafy-dev/instafy",
      GITHUB_EVENT_NAME: "push",
      GITHUB_ACTOR: "instafy-bot",
      PUSHER_NAME: "instafy-bot",
      GITHUB_REF: "refs/tags/desktop-app-v0.2.13",
      GITHUB_SHA: SHA,
    };
    const ok = spawnSync(process.execPath, [script, "request"], { env, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, "tag=desktop-app-v0.2.13\nmode=release\nversion=0.2.13\n");
    const bad = spawnSync(process.execPath, [script, "request"], { env: { ...env, PUSHER_NAME: "x" }, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /^::error::The release tag must be pushed by instafy-bot\./mu);
    const packagePath = path.join(dir, "package.json");
    fs.writeFileSync(packagePath, JSON.stringify({ name: "@instafy/desktop-app", version: "0.2.13" }));
    const source = spawnSync(process.execPath, [script, "source"], {
      env: { PATH: process.env.PATH, SOURCE_SHA: SHA, HEAD_SHA: SHA, PACKAGE_JSON_PATH: packagePath, VERSION: "0.2.13" },
      encoding: "utf8",
    });
    assert.equal(source.stdout, "version=0.2.13\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
