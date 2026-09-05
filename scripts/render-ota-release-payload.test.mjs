import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/render-ota-release-payload.mjs");

function writeManifest(dir, signature = "signed-bundle") {
  const manifestPath = path.join(dir, "bundle.manifest.json");
  const manifest = {
    schema_version: 1,
    bundle_version: "20260319T120000Z-deadbeef",
    git_sha: "deadbeefcafebabefeedface0123456789abcdef",
    created_at: "2026-03-19T12:00:00.000Z",
    source_dir: "packages/frontend/dist",
    artifact_type: "zip",
    archive_file_name: "20260319T120000Z-deadbeef.zip",
    archive_sha256: "a".repeat(64),
    archive_signature: signature,
    archive_size_bytes: 1234,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function runRender(args) {
  return spawnSync("node", [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("render-ota-release-payload preserves manifest signature by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-ota-render-"));
  const manifestPath = writeManifest(tempDir, "signed-from-manifest");
  const outPath = path.join(tempDir, "ios.release.json");

  const result = runRender([
    "--manifest",
    manifestPath,
    "--artifact-url",
    "https://downloads.instafy.dev/mobile/20260319T120000Z-deadbeef.zip",
    "--platform",
    "ios",
    "--channel",
    "stable",
    "--native-version",
    "1.0",
    "--out",
    outPath,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(payload.signature, "signed-from-manifest");
});

test("render-ota-release-payload allows explicit signature override", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-ota-render-"));
  const manifestPath = writeManifest(tempDir, "signed-from-manifest");
  const outPath = path.join(tempDir, "ios.release.json");

  const result = runRender([
    "--manifest",
    manifestPath,
    "--artifact-url",
    "https://downloads.instafy.dev/mobile/20260319T120000Z-deadbeef.zip",
    "--platform",
    "ios",
    "--channel",
    "stable",
    "--native-version",
    "1.0",
    "--signature",
    "override-signature",
    "--out",
    outPath,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(payload.signature, "override-signature");
});

test("render-ota-release-payload carries an exact optional native build without changing channel", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-ota-render-build-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const manifestPath = writeManifest(tempDir);
  const outPath = path.join(tempDir, "release.json");
  const baseArgs = [
    "--manifest", manifestPath, "--artifact-url", "https://artifacts.example.test/bundle.zip",
    "--platform", "ios", "--channel", "internal", "--native-version", "1.0", "--out", outPath,
  ];
  for (const build of ["80", "001.02.3"]) {
    const result = runRender([...baseArgs, "--required-native-build", build]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(payload.required_native_build, build);
    assert.equal(payload.channel, "internal");
    assert.equal(payload.status, "draft");
  }
  for (const build of ["", "80 ", "80\n", "1..2", "9".repeat(65)]) {
    const result = runRender([...baseArgs, `--required-native-build=${build}`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requiredNativeBuild/);
  }
  assert.notEqual(runRender([...baseArgs, "--required-native-build"]).status, 0);
});
