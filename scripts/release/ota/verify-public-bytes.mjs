#!/usr/bin/env node
// Verifies an OTA bundle the way a device does: with the public trust anchor
// only, never with the signing key.
//
//   anchor  CAPACITOR_LIVE_UPDATE_PUBLIC_KEY is RSA and its fingerprint equals
//           EXPECTED_TRUST_KEY_SHA256 (the resolver's public_key_sha256)
//   local   ARCHIVE_PATH + MANIFEST_PATH are the exact signed bundle for TAG
//           at SOURCE_SHA
//   public  the bytes served at ARCHIVE_URL / MANIFEST_URL are byte-identical
//           to the local files and verify as in `local`

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

export function normalizePem(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.replace(/\\n/g, "\n") : "";
}

// Same fingerprint as scripts/resolve-live-update-public-key.mjs.
export function pemFingerprint(pem) {
  return crypto.createHash("sha256").update(pem).digest("hex");
}

export function verifyTrustAnchor({ publicKeyPem, expectedSha256 }) {
  const pem = normalizePem(publicKeyPem);
  if (!pem) {
    fail("CAPACITOR_LIVE_UPDATE_PUBLIC_KEY is not configured");
  }
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    fail(`The native trust anchor must be an RSA key; received ${key.asymmetricKeyType}`);
  }
  const fingerprint = pemFingerprint(pem);
  if (expectedSha256 !== undefined && fingerprint !== expectedSha256) {
    fail("The native trust anchor fingerprint does not match the signing key's derived public key");
  }
  return fingerprint;
}

export function verifyBundle({ archive, manifestBytes, tag, sourceSha, publicKeyPem }) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    fail("The OTA manifest is not valid JSON");
  }
  if (manifest.schema_version !== 1) fail("Unexpected OTA manifest schema version");
  if (manifest.artifact_type !== "zip") fail("OTA releases must ship a zip artifact");
  if (manifest.bundle_version !== tag) fail("The OTA manifest bundle_version is not the release tag");
  if (manifest.archive_file_name !== `${tag}.zip`) fail("The OTA archive is not named <tag>.zip");
  if (manifest.git_sha !== sourceSha) fail("The OTA manifest does not record the exact release commit");
  if (manifest.archive_size_bytes !== archive.byteLength) fail("The OTA manifest archive size does not match the archive");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  if (manifest.archive_sha256 !== digest) fail("The OTA manifest checksum does not match the archive");
  if (typeof manifest.archive_signature !== "string" || !manifest.archive_signature) {
    fail("The OTA archive is unsigned");
  }
  const publicKey = crypto.createPublicKey(normalizePem(publicKeyPem));
  if (!crypto.verify("RSA-SHA256", archive, publicKey, Buffer.from(manifest.archive_signature, "base64"))) {
    fail("The OTA archive signature does not verify against the native trust anchor");
  }
  return { manifest, sha256: digest, sizeBytes: archive.byteLength };
}

export async function verifyPublicBytes({
  archivePath,
  manifestPath,
  archiveUrl,
  manifestUrl,
  tag,
  sourceSha,
  publicKeyPem,
  verifyToken,
  fetchImpl = fetch,
  attempts = 8,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 5000,
  log = console.log,
}) {
  for (const [label, url, suffix] of [
    ["ARCHIVE_URL", archiveUrl, `/${tag}.zip`],
    ["MANIFEST_URL", manifestUrl, `/${tag}.manifest.json`],
  ]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.search || !parsed.pathname.endsWith(suffix)) {
      fail(`${label} is not the immutable HTTPS object for ${tag}`);
    }
  }
  const localArchive = fs.readFileSync(archivePath);
  const localManifest = fs.readFileSync(manifestPath);
  const bust = `?verify=${encodeURIComponent(verifyToken)}`;
  const download = async (url) => {
    const response = await fetchImpl(`${url}${bust}`, { redirect: "error" });
    if (response.status !== 200) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let archive = null;
    let manifest = null;
    try {
      archive = await download(archiveUrl);
      manifest = archive ? await download(manifestUrl) : null;
    } catch {
      archive = null;
    }
    if (archive && manifest && archive.equals(localArchive) && manifest.equals(localManifest)) {
      return verifyBundle({ archive, manifestBytes: manifest, tag, sourceSha, publicKeyPem });
    }
    log(`[mobile-ota-release] attempt ${attempt}: public OTA bytes have not converged.`);
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  return fail("Published OTA bytes do not match the signed release artifacts");
}

async function main() {
  const env = process.env;
  const command = process.argv[2];
  if (command === "anchor") {
    const fingerprint = verifyTrustAnchor({
      publicKeyPem: env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY,
      expectedSha256: env.EXPECTED_TRUST_KEY_SHA256 || fail("EXPECTED_TRUST_KEY_SHA256 is required"),
    });
    console.log(`[mobile-ota-release] Native trust anchor sha256 ${fingerprint}.`);
    return;
  }
  if (command === "local") {
    const result = verifyBundle({
      archive: fs.readFileSync(env.ARCHIVE_PATH),
      manifestBytes: fs.readFileSync(env.MANIFEST_PATH),
      tag: env.TAG,
      sourceSha: env.SOURCE_SHA,
      publicKeyPem: env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY,
    });
    console.log(`[mobile-ota-release] ${env.TAG} verified: ${result.sizeBytes} bytes, sha256 ${result.sha256}`);
    return;
  }
  if (command === "public") {
    await verifyPublicBytes({
      archivePath: env.ARCHIVE_PATH,
      manifestPath: env.MANIFEST_PATH,
      archiveUrl: env.ARCHIVE_URL,
      manifestUrl: env.MANIFEST_URL,
      tag: env.TAG,
      sourceSha: env.SOURCE_SHA,
      publicKeyPem: env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY,
      verifyToken: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    });
    console.log("[mobile-ota-release] Public OTA bytes verified against the native trust anchor.");
    return;
  }
  fail("Usage: verify-public-bytes.mjs anchor|local|public");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
