import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MARKER, buildReceipt, digestFile, serializeReceipt, validateReceipt } from "./write-receipt.mjs";

const SOURCE = "a".repeat(40);
const TAG = "ios-v1.0-81";
const IPA_BYTES = Buffer.from("fixture signed ipa bytes");
const DIGEST = {
  sha256: createHash("sha256").update(IPA_BYTES).digest("hex"),
  md5: createHash("md5").update(IPA_BYTES).digest("hex"),
  sizeBytes: IPA_BYTES.length,
};
const TRUST = "7".repeat(64);

function post({ md5 = DIGEST.md5, sizeBytes = DIGEST.sizeBytes, build = {} } = {}) {
  return {
    schemaVersion: 1,
    provider: "app-store-connect",
    bundleId: "dev.instafy.studio",
    appId: "1234567890",
    nativeVersion: "1.0",
    preReleaseVersionId: "prv-1",
    buildUploads: [{
      id: "upload-81",
      buildNumber: "81",
      state: "COMPLETE",
      files: [{ id: "file-1", fileName: "Instafy.ipa", sizeBytes, uti: "com.apple.ipa", deliveryState: "COMPLETE", compositeMd5: md5, fileMd5: null, fileSha256: null }],
    }],
    betaGroupSelection: "unique-all-builds",
    betaGroup: { id: "group-1", hasAccessToAllBuilds: true },
    builds: [{
      id: "build-81",
      buildNumber: "81",
      processingState: "VALID",
      buildAudienceType: "INTERNAL_ONLY",
      internalBuildState: "IN_BETA_TESTING",
      expired: false,
      distributed: true,
      ...build,
    }],
    observedAt: "2026-09-17T10:00:00.000Z",
    stateSha256: "0".repeat(64),
  };
}

const ota = {
  schemaVersion: 1,
  lane: "ios",
  applicationId: "dev.instafy.studio",
  nativeVersion: "1.0",
  nativeBuild: "81",
  nativeArtifactSha256: DIGEST.sha256,
  channel: "internal",
  trustKeySha256: TRUST,
  marker: MARKER,
  sourceSha: SOURCE,
};

const common = {
  tag: TAG,
  sourceSha: SOURCE,
  marketing: "1.0",
  build: "81",
  run: { id: 123456789, attempt: 2 },
  workflowRef: "instafy-dev/instafy/.github/workflows/ios-release.yml@refs/tags/ios-v1.0-81",
  publishedAt: "2026-09-17T10:05:00Z",
};

test("builds the exact instafy-client-release-receipt-v1 shape for a local IPA", () => {
  const receipt = buildReceipt({ ...common, post: post(), ipaDigest: DIGEST, ota });
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    kind: "instafy-client-release-receipt-v1",
    lane: "ios",
    repository: "instafy-dev/instafy",
    tag: TAG,
    sourceSha: SOURCE,
    workflowRef: common.workflowRef,
    version: { marketingVersion: "1.0", buildNumber: "81" },
    destination: {
      type: "testflight-internal",
      bundleId: "dev.instafy.studio",
      appStoreConnect: {
        appId: "1234567890",
        preReleaseVersionId: "prv-1",
        buildUploadId: "upload-81",
        buildId: "build-81",
        betaGroupId: "group-1",
        processingState: "VALID",
        buildAudienceType: "INTERNAL_ONLY",
        internalBuildState: "IN_BETA_TESTING",
      },
      ipa: { fileName: "Instafy.ipa", ...DIGEST, digestSource: "local" },
      ota: { channel: "internal", trustKeySha256: TRUST, marker: MARKER },
    },
    artifacts: [{ name: "Instafy.ipa", sha256: DIGEST.sha256, sizeBytes: DIGEST.sizeBytes }],
    run: { id: 123456789, attempt: 2, url: "https://github.com/instafy-dev/instafy/actions/runs/123456789/attempts/2" },
    publishedAt: "2026-09-17T10:05:00Z",
  });
  assert.equal(serializeReceipt(receipt), `${JSON.stringify(receipt, null, 2)}\n`);
});

test("refuses unproven publication, mismatched bytes and version drift", () => {
  const cases = [
    [{ post: post({ build: { distributed: false } }) }, /does not prove an internal TestFlight build/u],
    [{ post: post({ build: { internalBuildState: "READY_FOR_BETA_TESTING" } }) }, /does not prove/u],
    [{ post: post({ md5: "1".repeat(32) }) }, /differs from the local IPA/u],
    [{ post: post({ sizeBytes: 1 }) }, /differs from the local IPA/u],
    [{ ota: { ...ota, nativeArtifactSha256: "1".repeat(64) } }, /does not bind this IPA/u],
    [{ ota: { ...ota, channel: "stable" } }, /does not bind this IPA/u],
    [{ ota: { ...ota, sourceSha: "b".repeat(40) } }, /does not bind this IPA/u],
    [{ build: "82" }, /tag does not encode the version/u],
    [{ workflowRef: "instafy-dev/instafy/.github/workflows/other.yml@refs/heads/main" }, /workflow ref/u],
    [{ publishedAt: "2026-09-17T10:05:00.123Z" }, /second precision/u],
    [{ run: { id: "123", attempt: 1 } }, /run.id/u],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => buildReceipt({ ...common, post: post(), ipaDigest: DIGEST, ota, ...override }), expected, JSON.stringify(override));
  }
});

test("reconcile_only receipts use App Store Connect digests and attach no artifacts", () => {
  const reconciled = { ...post(), uploadedIpa: { sizeBytes: 4096, md5: DIGEST.md5, sha256: null } };
  const receipt = buildReceipt({ ...common, post: reconciled, trustKeySha256: TRUST });
  assert.deepEqual(receipt.destination.ipa, { fileName: "Instafy.ipa", sha256: null, md5: DIGEST.md5, sizeBytes: 4096, digestSource: "app-store-connect" });
  assert.deepEqual(receipt.artifacts, []);
  assert.throws(
    () => buildReceipt({ ...common, post: { ...post(), uploadedIpa: { sizeBytes: 1, md5: null, sha256: null } }, trustKeySha256: TRUST }),
    /no digest proof/u,
  );
});

test("the validator refuses anything that looks like a credential", () => {
  const receipt = buildReceipt({ ...common, post: post(), ipaDigest: DIGEST, ota });
  const leaks = [
    ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    ["sb", "secret", "abcdefghijklmnopqrstuvwxyz"].join("_"),
    ["gh", "p_", "abcdefghijklmnopqrstuvwxyz"].join(""),
    ["github", "pat", "abcdefghij"].join("_"),
    ["ey", "JhbGciOiJIUzI1NiJ9.e30.x"].join(""),
  ];
  for (const leak of leaks) {
    const tampered = structuredClone(receipt);
    tampered.destination.appStoreConnect.buildId = "build-81";
    tampered.workflowRef = `${receipt.workflowRef}${leak}`;
    assert.throws(() => validateReceipt(tampered), /credential|workflow ref/u);
    const idLeak = structuredClone(receipt);
    idLeak.artifacts[0].name = "Instafy.ipa";
    idLeak.destination.bundleId = leak;
    assert.throws(() => validateReceipt(idLeak), /destination identity|credential/u);
  }
  const extra = structuredClone(receipt);
  extra.token = "x";
  assert.throws(() => validateReceipt(extra), /keys are not exact/u);
});

test("CLI digests the IPA, validates, and writes release-receipt.json once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-receipt-"));
  try {
    const ipa = path.join(dir, "Instafy.ipa");
    fs.writeFileSync(ipa, IPA_BYTES);
    assert.deepEqual(digestFile(ipa), DIGEST);
    fs.writeFileSync(path.join(dir, "post.json"), JSON.stringify(post()));
    fs.writeFileSync(path.join(dir, "ota.json"), JSON.stringify(ota));
    const out = path.join(dir, "release-receipt.json");
    const args = [
      new URL("./write-receipt.mjs", import.meta.url).pathname,
      "--tag", TAG, "--source-sha", SOURCE, "--marketing", "1.0", "--build", "81",
      "--ipa", ipa, "--post", path.join(dir, "post.json"), "--ota", path.join(dir, "ota.json"), "--out", out,
    ];
    const env = {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: "instafy-dev/instafy",
      GITHUB_WORKFLOW_REF: common.workflowRef,
      GITHUB_RUN_ID: "123456789",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const first = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(validateReceipt(receipt), true);
    assert.match(receipt.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    const second = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(second.status, 1);
    const fork = spawnSync(process.execPath, args, { env: { ...env, GITHUB_REPOSITORY: "fork/instafy" }, encoding: "utf8" });
    assert.equal(fork.status, 1);
    assert.match(fork.stderr, /only in the public repository/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
