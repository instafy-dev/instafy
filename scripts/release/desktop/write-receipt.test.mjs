import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDesktopReceipt,
  findSecretLikeValue,
  main,
  validateDesktopReceipt,
} from "./write-receipt.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const input = {
  tag: "desktop-app-v0.2.13",
  sourceSha: SHA,
  workflowRef: "instafy-dev/instafy/.github/workflows/desktop-release.yml@refs/tags/desktop-app-v0.2.13",
  downloadsBaseUrl: "https://downloads.instafy.dev/",
  downloadsPrefix: "desktop-app",
  previousStableVersion: "0.2.12",
  canary: "launch-smoke",
  runId: "35123978000",
  runAttempt: "2",
  publishedAt: "2026-09-17T10:11:12Z",
  artifacts: [{ name: "instafy-0.2.13-mac-arm64.dmg", sha256: "a".repeat(64), sizeBytes: 12 }],
};

test("builds the shared receipt shape with desktop version and destination", () => {
  const receipt = buildDesktopReceipt(input);
  assert.deepEqual(Object.keys(receipt), [
    "schemaVersion", "kind", "lane", "repository", "tag", "sourceSha", "workflowRef",
    "version", "destination", "artifacts", "run", "publishedAt",
  ]);
  assert.equal(receipt.kind, "instafy-client-release-receipt-v1");
  assert.deepEqual(receipt.version, { semver: "0.2.13" });
  assert.deepEqual(receipt.destination, {
    type: "downloads-r2",
    feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
    latestJsonUrl: "https://downloads.instafy.dev/desktop-app/latest.json",
    immutableBaseUrl: "https://downloads.instafy.dev/desktop-app/desktop-app-v0.2.13",
    previousStableVersion: "0.2.12",
    canary: "launch-smoke",
  });
  assert.deepEqual(receipt.run, {
    id: 35123978000,
    attempt: 2,
    url: "https://github.com/instafy-dev/instafy/actions/runs/35123978000/attempts/2",
  });
  assert.equal(buildDesktopReceipt({ ...input, previousStableVersion: "" }).destination.previousStableVersion, null);
  assert.match(buildDesktopReceipt({ ...input, publishedAt: undefined }).publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
});

test("rejects shape drift and non-numeric run identifiers", () => {
  assert.throws(() => buildDesktopReceipt({ ...input, runId: "QUJDREVGR0hJSktMTU5PUFFSU1Q=" }), /GITHUB_RUN_ID/u);
  assert.throws(() => buildDesktopReceipt({ ...input, canary: "none" }), /canary/u);
  assert.throws(() => buildDesktopReceipt({ ...input, sourceSha: SHA.slice(0, 12) }), /sourceSha/u);
  assert.throws(() => buildDesktopReceipt({ ...input, workflowRef: "instafy-dev/instafy/.github/workflows/other.yml@refs/heads/main" }), /workflowRef/u);
  assert.throws(() => buildDesktopReceipt({ ...input, artifacts: [] }), /non-empty/u);
  assert.throws(() => buildDesktopReceipt({ ...input, artifacts: [{ ...input.artifacts[0], name: "release-receipt.json" }] }), /other than the receipt/u);
  const receipt = buildDesktopReceipt(input);
  assert.throws(() => validateDesktopReceipt({ ...receipt, extra: true }), /exactly/u);
  assert.throws(() => validateDesktopReceipt({ ...receipt, version: { semver: "0.2.14" } }), /tag version/u);
});

test("refuses values that look like credential material", () => {
  const markers = [
    ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
    ["sb", "secret", "x"].join("_"),
    ["github", "pat", "x"].join("_"),
    ["gh", "p_x"].join(""),
    "eyJhbGciOi",
  ];
  for (const marker of markers) {
    assert.equal(findSecretLikeValue({ nested: [{ value: `prefix ${marker}` }] }), "receipt.nested[0].value");
    assert.throws(
      () => buildDesktopReceipt({ ...input, artifacts: [{ ...input.artifacts[0], name: "a" }], workflowRef: `${input.workflowRef}${marker}` }),
      /workflowRef|looks like a secret/u,
    );
  }
  const receipt = buildDesktopReceipt(input);
  assert.throws(
    () => validateDesktopReceipt({ ...receipt, publishedAt: receipt.publishedAt, destination: { ...receipt.destination }, tag: receipt.tag, workflowRef: `${receipt.workflowRef}eyJ` }),
    /looks like a secret/u,
  );
});

test("CLI hashes artifacts, writes 2-space JSON once and never overwrites", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-receipt-"));
  try {
    const dmg = path.join(dir, "instafy-0.2.13-mac-arm64.dmg");
    const yml = path.join(dir, "latest-mac.yml");
    fs.writeFileSync(dmg, "dmg-bytes");
    fs.writeFileSync(yml, "version: 0.2.13\n");
    const env = {
      RECEIPT_PATH: path.join(dir, "release-receipt.json"),
      TAG: input.tag,
      SOURCE_SHA: SHA,
      WORKFLOW_REF: input.workflowRef,
      DOWNLOADS_BASE_URL: "https://downloads.instafy.dev",
      DESKTOP_DOWNLOADS_PREFIX: "desktop-app",
      PREVIOUS_STABLE_VERSION: "",
      CANARY_MODE: "personal-browser",
      GITHUB_RUN_ID: "7",
      GITHUB_RUN_ATTEMPT: "1",
      PUBLISHED_AT: input.publishedAt,
    };
    const receipt = main([dmg, yml], env);
    const written = fs.readFileSync(env.RECEIPT_PATH, "utf8");
    assert.equal(written, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.deepEqual(receipt.artifacts, [
      { name: "instafy-0.2.13-mac-arm64.dmg", sha256: createHash("sha256").update("dmg-bytes").digest("hex"), sizeBytes: 9 },
      { name: "latest-mac.yml", sha256: createHash("sha256").update("version: 0.2.13\n").digest("hex"), sizeBytes: 16 },
    ]);
    assert.throws(() => main([dmg], env), /EEXIST/u);
    assert.throws(() => main([dmg], { ...env, RECEIPT_PATH: path.join(dir, "receipt.json") }), /release-receipt\.json/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
