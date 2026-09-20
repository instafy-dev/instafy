import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { SOURCE_SHA, TAG, buildSignedBundle, generateKeys } from "./fixtures.mjs";
import { pemFingerprint, normalizePem, verifyBundle, verifyPublicBytes, verifyTrustAnchor } from "./verify-public-bytes.mjs";

const BASE = "https://downloads.instafy.dev/mobile";

function stubFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const key = url.split("?")[0];
    const body = routes[key];
    if (typeof body === "function") return body(url);
    if (!body) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

test("the trust anchor must be RSA and match the resolver fingerprint", () => {
  const keys = generateKeys();
  const expected = pemFingerprint(normalizePem(keys.publicKeyPem));
  assert.equal(verifyTrustAnchor({ publicKeyPem: keys.publicKeyPem.trim().replace(/\n/g, "\\n"), expectedSha256: expected }), expected);
  assert.throws(() => verifyTrustAnchor({ publicKeyPem: keys.publicKeyPem, expectedSha256: "0".repeat(64) }), /does not match/u);
  assert.throws(() => verifyTrustAnchor({ publicKeyPem: "" }), /not configured/u);
});

test("a signed bundle verifies like a device and tampering is refused", () => {
  const bundle = buildSignedBundle();
  try {
    const archive = fs.readFileSync(bundle.archivePath);
    const manifestBytes = fs.readFileSync(bundle.manifestPath);
    const ok = verifyBundle({ archive, manifestBytes, tag: TAG, sourceSha: SOURCE_SHA, publicKeyPem: bundle.keys.publicKeyPem });
    assert.equal(ok.manifest.bundle_version, TAG);
    assert.equal(ok.manifest.archive_file_name, `${TAG}.zip`);

    const other = generateKeys();
    assert.throws(() => verifyBundle({ archive, manifestBytes, tag: TAG, sourceSha: SOURCE_SHA, publicKeyPem: other.publicKeyPem }), /signature does not verify/u);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => verifyBundle({ archive: tampered, manifestBytes, tag: TAG, sourceSha: SOURCE_SHA, publicKeyPem: bundle.keys.publicKeyPem }), /checksum/u);
    assert.throws(() => verifyBundle({ archive, manifestBytes, tag: TAG, sourceSha: "f".repeat(40), publicKeyPem: bundle.keys.publicKeyPem }), /exact release commit/u);
    assert.throws(() => verifyBundle({ archive, manifestBytes, tag: "ota-v000000000000", sourceSha: SOURCE_SHA, publicKeyPem: bundle.keys.publicKeyPem }), /bundle_version/u);
    const unsigned = Buffer.from(JSON.stringify({ ...ok.manifest, archive_signature: null }));
    assert.throws(() => verifyBundle({ archive, manifestBytes: unsigned, tag: TAG, sourceSha: SOURCE_SHA, publicKeyPem: bundle.keys.publicKeyPem }), /unsigned/u);
  } finally {
    bundle.cleanup();
  }
});

test("public bytes converge after propagation and are fetched with a cache-buster", async () => {
  const bundle = buildSignedBundle();
  try {
    let archiveHits = 0;
    const calls = [];
    const routes = {
      [`${BASE}/${TAG}.zip`]: () => {
        archiveHits += 1;
        return archiveHits < 2 ? new Response("stale", { status: 404 }) : new Response(fs.readFileSync(bundle.archivePath));
      },
      [`${BASE}/${TAG}.manifest.json`]: fs.readFileSync(bundle.manifestPath),
    };
    const logs = [];
    const result = await verifyPublicBytes({
      archivePath: bundle.archivePath,
      manifestPath: bundle.manifestPath,
      archiveUrl: `${BASE}/${TAG}.zip`,
      manifestUrl: `${BASE}/${TAG}.manifest.json`,
      tag: TAG,
      sourceSha: SOURCE_SHA,
      publicKeyPem: bundle.keys.publicKeyPem,
      verifyToken: "42-1",
      fetchImpl: stubFetch(routes, calls),
      sleep: async () => {},
      log: (line) => logs.push(line),
    });
    assert.equal(result.manifest.git_sha, SOURCE_SHA);
    assert.equal(logs.length, 1);
    assert.ok(calls.every((url) => url.endsWith("?verify=42-1")));
  } finally {
    bundle.cleanup();
  }
});

test("different public bytes never converge and fail closed", async () => {
  const bundle = buildSignedBundle();
  try {
    const routes = {
      [`${BASE}/${TAG}.zip`]: Buffer.from("not the archive"),
      [`${BASE}/${TAG}.manifest.json`]: fs.readFileSync(bundle.manifestPath),
    };
    const options = {
      archivePath: bundle.archivePath,
      manifestPath: bundle.manifestPath,
      archiveUrl: `${BASE}/${TAG}.zip`,
      manifestUrl: `${BASE}/${TAG}.manifest.json`,
      tag: TAG,
      sourceSha: SOURCE_SHA,
      publicKeyPem: bundle.keys.publicKeyPem,
      verifyToken: "1-1",
      fetchImpl: stubFetch(routes),
      sleep: async () => {},
      log: () => {},
      attempts: 3,
    };
    await assert.rejects(verifyPublicBytes(options), /do not match/u);
    await assert.rejects(verifyPublicBytes({ ...options, archiveUrl: `http://downloads.instafy.dev/mobile/${TAG}.zip` }), /immutable HTTPS object/u);
    await assert.rejects(verifyPublicBytes({ ...options, manifestUrl: `${BASE}/other.manifest.json` }), /immutable HTTPS object/u);
  } finally {
    bundle.cleanup();
  }
});
