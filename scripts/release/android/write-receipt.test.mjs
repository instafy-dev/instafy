import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalSha256, summarizeGoogleState } from "./google-play-internal.mjs";
import { assertSecretFree, buildReceipt, parseArguments, validateReceipt } from "./write-receipt.mjs";

const TAG = "android-v1.0-260860839";
const SOURCE = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const TRUST = "c".repeat(64);
const ENV = {
  GITHUB_REPOSITORY: "instafy-dev/instafy",
  GITHUB_WORKFLOW_REF: `instafy-dev/instafy/.github/workflows/android-release.yml@refs/tags/${TAG}`,
  GITHUB_RUN_ID: "35123456789",
  GITHUB_RUN_ATTEMPT: "2",
};
const SCRIPT = path.join(import.meta.dirname, "write-receipt.mjs");

function playObservation(sha256, { name = "1.0 (260860839)", code = "260860839" } = {}) {
  const state = {
    schemaVersion: 1,
    provider: "google-play",
    applicationId: "dev.instafy.studio",
    track: "internal",
    bundles: [
      { versionCode: "260860838", sha1: "1".repeat(40), sha256: "2".repeat(64) },
      { versionCode: code, sha1: "1".repeat(40), sha256 },
    ],
    releases: [{ name, status: "completed", versionCodes: [code] }],
  };
  return { ...state, ...summarizeGoogleState(state), stateSha256: canonicalSha256(state), observedAt: "2026-09-17T10:00:00.000Z" };
}

function withInputs(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-receipt-"));
  try {
    const aab = path.join(root, "app-release.aab");
    fs.writeFileSync(aab, "signed android app bundle bytes");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(aab)).digest("hex");
    const ota = {
      schemaVersion: 1,
      applicationId: "dev.instafy.studio",
      versionName: "1.0",
      versionCode: "260860839",
      channel: "internal",
      trustKeySha256: TRUST,
      nativeArtifactSha256: sha256,
      sourceSha: SOURCE,
    };
    return check({ root, aab, sha256, ota, post: playObservation(sha256) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function build(inputs, overrides = {}) {
  return buildReceipt({
    tag: TAG,
    sourceSha: SOURCE,
    versionName: "1.0",
    versionCode: "260860839",
    aabPath: inputs.aab,
    ota: inputs.ota,
    post: inputs.post,
    env: ENV,
    publishedAt: "2026-09-17T10:00:05Z",
    ...overrides,
  });
}

test("writes the exact shared receipt schema for the android lane", () => {
  withInputs((inputs) => {
    assert.deepEqual(build(inputs), {
      schemaVersion: 1,
      kind: "instafy-client-release-receipt-v1",
      lane: "android",
      repository: "instafy-dev/instafy",
      tag: TAG,
      sourceSha: SOURCE,
      workflowRef: ENV.GITHUB_WORKFLOW_REF,
      version: { versionName: "1.0", versionCode: "260860839" },
      destination: {
        type: "play-internal",
        applicationId: "dev.instafy.studio",
        track: "internal",
        releaseStatus: "completed",
        releaseName: "1.0 (260860839)",
        aab: { fileName: "app-release.aab", sha256: inputs.sha256, sizeBytes: 31 },
        play: { observedAt: "2026-09-17T10:00:00.000Z", stateSha256: inputs.post.stateSha256 },
        ota: { channel: "internal", trustKeySha256: TRUST },
      },
      artifacts: [{ name: "app-release.aab", sha256: inputs.sha256, sizeBytes: 31 }],
      run: { id: 35123456789, attempt: 2, url: "https://github.com/instafy-dev/instafy/actions/runs/35123456789/attempts/2" },
      publishedAt: "2026-09-17T10:00:05Z",
    });
    assert.match(build(inputs, { publishedAt: undefined }).publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });
});

test("refuses inputs that do not prove the exact published release", () => {
  withInputs((inputs) => {
    const cases = [
      [{ versionCode: "260860840" }, /version differs from the tag/u],
      [{ sourceSha: "short" }, /source sha is invalid/u],
      [{ ota: { ...inputs.ota, nativeArtifactSha256: "d".repeat(64) } }, /OTA attestation differs/u],
      [{ ota: { ...inputs.ota, channel: "stable" } }, /OTA attestation differs/u],
      [{ ota: { ...inputs.ota, sourceSha: "e".repeat(40) } }, /OTA attestation differs/u],
      [{ ota: { ...inputs.ota, extra: true } }, /keys are not exact/u],
      [{ post: playObservation("f".repeat(64)) }, /does not prove the exact internal release/u],
      [{ post: playObservation(inputs.sha256, { name: "draft name" }) }, /does not prove/u],
      [{ post: { ...inputs.post, stateSha256: "0".repeat(64) } }, /digest does not match/u],
      [{ env: { ...ENV, GITHUB_WORKFLOW_REF: "instafy-dev/instafy/.github/workflows/other.yml@refs/heads/main" } }, /workflowRef is invalid/u],
      [{ env: { ...ENV, GITHUB_RUN_ID: "abc" } }, /GITHUB_RUN_ID must be a positive integer/u],
      [{ env: { ...ENV, GITHUB_REPOSITORY: "someone/fork" } }, /GITHUB_REPOSITORY is not exact/u],
      [{ publishedAt: "2026-09-17T10:00:05.123Z" }, /publishedAt is invalid/u],
    ];
    for (const [overrides, error] of cases) {
      assert.throws(() => build(inputs, overrides), error, JSON.stringify(Object.keys(overrides)));
    }
    const renamed = path.join(inputs.root, "other.aab");
    fs.copyFileSync(inputs.aab, renamed);
    assert.throws(() => build(inputs, { aabPath: renamed }), /must be named app-release\.aab/u);
  });
});

test("self-validation rejects tampered receipts and credential-looking values", () => {
  withInputs((inputs) => {
    const receipt = build(inputs);
    assert.throws(() => validateReceipt({ ...receipt, lane: "ios" }), /identity is not exact/u);
    assert.throws(() => validateReceipt({ ...receipt, extra: 1 }), /keys are not exact/u);
    assert.throws(() => validateReceipt({ ...receipt, run: { ...receipt.run, id: "35123456789" } }), /run\.id must be a positive integer/u);
    assert.throws(
      () => validateReceipt({ ...receipt, artifacts: [{ ...receipt.artifacts[0], sha256: "a".repeat(64) }] }),
      /differs from the published AAB/u,
    );
    for (const value of [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      ["sb", "secret", "x"].join("_"),
      ["github", "pat", "x"].join("_"),
      ["gh", "p_x"].join(""),
      "eyJhbGciOi",
    ]) {
      assert.throws(() => assertSecretFree({ nested: [value] }), /looks like a credential/u);
    }
  });
});

test("CLI prints validated JSON and reports errors as annotations", () => {
  withInputs((inputs) => {
    const ota = path.join(inputs.root, "ota.json");
    const post = path.join(inputs.root, "post.json");
    fs.writeFileSync(ota, JSON.stringify(inputs.ota));
    fs.writeFileSync(post, JSON.stringify(inputs.post));
    const args = ["--tag", TAG, "--source-sha", SOURCE, "--name", "1.0", "--code", "260860839", "--aab", inputs.aab, "--ota", ota, "--post", post];
    const ok = spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...ENV }, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).destination.aab.sha256, inputs.sha256);
    assert.ok(ok.stdout.startsWith('{\n  "schemaVersion": 1,'));
    const bad = spawnSync(process.execPath, [SCRIPT, ...args.slice(0, -2)], { env: { PATH: process.env.PATH, ...ENV }, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^::error::\[android-receipt\] --post is required/u);
    assert.throws(() => parseArguments(["--tag", TAG, "--tag", TAG]), /usage/u);
  });
});
