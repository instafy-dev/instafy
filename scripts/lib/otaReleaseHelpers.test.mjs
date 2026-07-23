import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildBundleManifest,
  buildReleaseRegistration,
  createBundleVersion,
  sha256Hex,
  signBufferWithRsaSha256,
  verifyBufferSignatureWithRsaSha256,
} from "./otaReleaseHelpers.mjs";

test("createBundleVersion includes timestamp and short sha", () => {
  const version = createBundleVersion({
    createdAt: "2026-03-18T12:34:56.000Z",
    gitSha: "e7c0e985abcdef0123456789",
  });
  assert.equal(version, "20260318T123456Z-e7c0e985");
});

test("sha256Hex returns a stable digest", () => {
  assert.equal(
    sha256Hex(Buffer.from("instafy")),
    "0a6695ffac4bb8acc3c4184f0b5fba6267867ed57795781fac9c5b36e7965f66"
  );
});

test("buildReleaseRegistration carries manifest integrity fields forward", () => {
  const manifest = buildBundleManifest({
    bundleVersion: "20260318T123456Z-e7c0e985",
    gitSha: "e7c0e985abcdef0123456789",
    createdAt: "2026-03-18T12:34:56.000Z",
    archiveFileName: "20260318T123456Z-e7c0e985.zip",
    archiveSha256: "a".repeat(64),
    archiveSignature: "signed-bundle",
    archiveSizeBytes: 12345,
    sourceDir: "packages/frontend/dist",
  });

  const payload = buildReleaseRegistration({
    manifest,
    artifactUrl: "https://downloads.instafy.dev/mobile/20260318T123456Z-e7c0e985.zip",
    platform: "ios",
    channel: "beta",
    nativeVersion: "1.0.0",
    rolloutPercentage: 25,
    status: "live",
    publishedAt: "2026-03-18T12:35:00.000Z",
    publishedBy: "github-actions",
  });

  assert.deepEqual(payload, {
    release_id: "ios-beta-20260318T123456Z-e7c0e985",
    platform: "ios",
    channel: "beta",
    bundle_version: "20260318T123456Z-e7c0e985",
    git_sha: "e7c0e985abcdef0123456789",
    native_version: "1.0.0",
    min_supported_native_version: "1.0.0",
    artifact_url: "https://downloads.instafy.dev/mobile/20260318T123456Z-e7c0e985.zip",
    artifact_sha256: "a".repeat(64),
    artifact_size_bytes: 12345,
    artifact_type: "zip",
    signature: "signed-bundle",
    rollout_percentage: 25,
    status: "live",
    published_at: "2026-03-18T12:35:00.000Z",
    published_by: "github-actions",
    notes: null,
  });
});

test("buildReleaseRegistration rejects invalid rollout values", () => {
  const manifest = buildBundleManifest({
    bundleVersion: "20260318T123456Z-e7c0e985",
    gitSha: "e7c0e985abcdef0123456789",
    createdAt: "2026-03-18T12:34:56.000Z",
    archiveFileName: "20260318T123456Z-e7c0e985.zip",
    archiveSha256: "a".repeat(64),
    archiveSizeBytes: 12345,
    sourceDir: "packages/frontend/dist",
  });

  assert.throws(() => {
    buildReleaseRegistration({
      manifest,
      artifactUrl: "https://downloads.instafy.dev/mobile/20260318T123456Z-e7c0e985.zip",
      platform: "ios",
      channel: "beta",
      nativeVersion: "1.0.0",
      rolloutPercentage: 101,
    });
  }, /rolloutPercentage/);
});

test("RSA SHA256 signatures round-trip against the generated public key", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const buffer = Buffer.from("instafy-ota-bundle");
  const signature = signBufferWithRsaSha256(
    buffer,
    privateKey.export({ format: "pem", type: "pkcs1" }),
  );

  assert.equal(
    verifyBufferSignatureWithRsaSha256(
      buffer,
      signature,
      publicKey.export({ format: "pem", type: "spki" }),
    ),
    true,
  );
});
