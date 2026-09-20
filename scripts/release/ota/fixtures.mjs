// Shared test fixtures for the OTA lane tests: a real signed bundle produced
// by the public scripts/build-ota-bundle.mjs with a throwaway RSA key.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
export const SOURCE_SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
export const TAG = "ota-v8ddffed21d44";

export function generateKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export function buildSignedBundle({ keys = generateKeys(), tag = TAG, sourceSha = SOURCE_SHA } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ota-lane-test-"));
  const dist = path.join(root, "dist");
  const out = path.join(root, "ota");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html><meta name="build" content="${sourceSha}">`);
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('ota');\n");
  const env = { ...process.env, OTA_SIGNING_PRIVATE_KEY: keys.privateKeyPem };
  delete env.GITHUB_OUTPUT;
  execFileSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "build-ota-bundle.mjs"), "--dist", dist, "--out", out, "--git-sha", sourceSha, "--bundle-version", tag],
    { env, stdio: "pipe" },
  );
  return {
    root,
    keys,
    out,
    archivePath: path.join(out, `${tag}.zip`),
    manifestPath: path.join(out, `${tag}.manifest.json`),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function renderPayload(bundle, { platform, nativeVersion, build, archiveUrl, tag = TAG }) {
  const outFile = path.join(bundle.out, `${platform}-internal-${tag}.release.json`);
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts", "render-ota-release-payload.mjs"),
      "--manifest", bundle.manifestPath,
      "--artifact-url", archiveUrl,
      "--platform", platform,
      "--channel", "internal",
      "--native-version", nativeVersion,
      "--min-supported-native-version", nativeVersion,
      "--required-native-build", build,
      "--status", "live",
      "--rollout-percentage", "100",
      "--published-by", "github-actions:mobile-ota-release:1",
      "--published-at", "2026-09-17T00:00:00Z",
      "--out", outFile,
    ],
    { env, stdio: "pipe" },
  );
  return outFile;
}
