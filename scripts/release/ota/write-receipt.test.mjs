import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { SOURCE_SHA, TAG, buildSignedBundle, renderPayload } from "./fixtures.mjs";
import { assertSecretFree, buildReceipt, parseArguments, validateReceipt } from "./write-receipt.mjs";

const BASE = "https://downloads.instafy.dev/mobile";
const TRUST = "a".repeat(64);

function withRelease(body) {
  const bundle = buildSignedBundle();
  try {
    const archiveUrl = `${BASE}/${TAG}.zip`;
    const ios = renderPayload(bundle, { platform: "ios", nativeVersion: "1.0", build: "81", archiveUrl });
    const android = renderPayload(bundle, { platform: "android", nativeVersion: "1.0", build: "260860839", archiveUrl });
    const argv = [
      "--tag", TAG, "--source-sha", SOURCE_SHA,
      "--workflow-ref", "instafy-dev/instafy/.github/workflows/mobile-ota-release.yml@refs/tags/ota-v8ddffed21d44",
      "--ios-marketing-version", "1.0", "--ios-build-number", "81",
      "--android-version-name", "1.0", "--android-version-code", "260860839",
      "--archive", bundle.archivePath, "--manifest", bundle.manifestPath,
      "--archive-url", archiveUrl, "--manifest-url", `${BASE}/${TAG}.manifest.json`,
      "--payload", `ios=${ios}`, "--payload", `android=${android}`,
      "--trust-key-sha256", TRUST, "--run-id", "35123978000", "--run-attempt", "2",
      "--published-at", "2026-09-17T08:00:00Z",
      "--out", path.join(bundle.root, "release-receipt.json"),
    ];
    body({ bundle, argv, ios, android });
  } finally {
    bundle.cleanup();
  }
}

test("writes the shared receipt shape for the OTA lane", () => {
  withRelease(({ argv, bundle }) => {
    const receipt = buildReceipt(parseArguments(argv));
    assert.equal(receipt.kind, "instafy-client-release-receipt-v1");
    assert.equal(receipt.lane, "ota");
    assert.deepEqual(receipt.version, {
      bundleVersion: TAG,
      ios: { marketingVersion: "1.0", buildNumber: "81" },
      android: { versionName: "1.0", versionCode: "260860839" },
    });
    assert.deepEqual(receipt.destination.payloads.map((p) => p.releaseId), [`ios-internal-${TAG}`, `android-internal-${TAG}`]);
    assert.deepEqual(receipt.artifacts.map((a) => a.name), [
      `${TAG}.zip`, `${TAG}.manifest.json`, `ios-internal-${TAG}.release.json`, `android-internal-${TAG}.release.json`,
    ]);
    assert.equal(receipt.destination.archiveSizeBytes, fs.statSync(bundle.archivePath).size);
    assert.equal(receipt.destination.activation, "private-train");
    assert.equal(receipt.run.url, "https://github.com/instafy-dev/instafy/actions/runs/35123978000/attempts/2");
    assert.deepEqual(Object.keys(receipt), [
      "schemaVersion", "kind", "lane", "repository", "tag", "sourceSha", "workflowRef", "version", "destination", "artifacts", "run", "publishedAt",
    ]);
  });
});

test("the CLI writes release-receipt.json once and refuses other names", () => {
  withRelease(({ argv, bundle }) => {
    const script = path.join(import.meta.dirname, "write-receipt.mjs");
    const first = spawnSync(process.execPath, [script, ...argv], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const written = fs.readFileSync(path.join(bundle.root, "release-receipt.json"), "utf8");
    assert.ok(written.startsWith('{\n  "schemaVersion": 1,'));
    validateReceipt(JSON.parse(written));
    const again = spawnSync(process.execPath, [script, ...argv], { encoding: "utf8" });
    assert.notEqual(again.status, 0);
    const renamed = argv.map((value) => (value.endsWith("release-receipt.json") ? path.join(bundle.root, "receipt.json") : value));
    const wrongName = spawnSync(process.execPath, [script, ...renamed], { encoding: "utf8" });
    assert.match(wrongName.stdout, /must be named release-receipt\.json/u);
  });
});

test("payloads that disagree with the release are refused", () => {
  withRelease(({ argv, ios }) => {
    const payload = JSON.parse(fs.readFileSync(ios, "utf8"));
    fs.writeFileSync(ios, JSON.stringify({ ...payload, required_native_build: "80" }));
    assert.throws(() => buildReceipt(parseArguments(argv)), /required_native_build/u);
    fs.writeFileSync(ios, JSON.stringify({ ...payload, channel: "stable" }));
    assert.throws(() => buildReceipt(parseArguments(argv)), /channel/u);
  });
  withRelease(({ argv }) => {
    const options = parseArguments(argv);
    assert.throws(() => buildReceipt({ ...options, sourceSha: "f".repeat(40) }), /does not describe/u);
    assert.throws(() => buildReceipt({ ...options, tag: "ota-v000000000000" }), /named after the tag/u);
  });
});

test("validation rejects secrets, loose numbers and extra fields", () => {
  withRelease(({ argv }) => {
    const receipt = buildReceipt(parseArguments(argv));
    const clone = () => JSON.parse(JSON.stringify(receipt));
    const withSecret = clone();
    withSecret.workflowRef = `${receipt.workflowRef} ${["sb", "secret", "abc"].join("_")}`;
    assert.throws(() => validateReceipt(withSecret), /looks like a secret/u);
    const pem = clone();
    pem.version.ios.marketingVersion = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    assert.throws(() => validateReceipt(pem), /looks like a secret/u);
    const stringNumber = clone();
    stringNumber.run.id = "35123978000";
    assert.throws(() => validateReceipt(stringNumber), /non-negative integer/u);
    const extra = clone();
    extra.destination.controllerToken = "x";
    assert.throws(() => validateReceipt(extra), /unexpected fields/u);
    const wrongLane = clone();
    wrongLane.lane = "desktop";
    assert.throws(() => validateReceipt(wrongLane), /lane must be ota/u);
    const precision = clone();
    precision.publishedAt = "2026-09-17T08:00:00.123Z";
    assert.throws(() => validateReceipt(precision), /second precision/u);
  });
  assert.throws(() => assertSecretFree({ a: ["ok", ["gh", "p_abc"].join("")] }), /receipt\.a\[1\]/u);
  assert.throws(() => assertSecretFree(["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTYifQ", "sig"].join(".")), /looks like a secret/u);
  assert.doesNotThrow(() => assertSecretFree(["abc+", "eyJhbGci", "/def=="].join("")));
});

test("argument parsing is strict", () => {
  assert.throws(() => parseArguments(["--tag"]), /requires a value/u);
  assert.throws(() => parseArguments(["--tag", "a", "--tag", "b"]), /repeated/u);
  assert.throws(() => parseArguments(["--payload", "web=x"]), /ios=<file>/u);
  assert.throws(() => parseArguments(["--tag", TAG]), /Missing required/u);
});
