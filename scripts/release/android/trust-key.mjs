#!/usr/bin/env node
// Canonical OTA trust-key fingerprint for the Android lane.
//
// The OTA authority fingerprints the embedded key as sha256 of
// createPublicKey(key).export({type:"spki",format:"pem"}).toString().trim().
// resolve-live-update-public-key.mjs and inspect-aab.py hash the configured
// text as given (trim + literal "\n" expansion). Both digests agree only when
// that text already IS the canonical SPKI PEM, so this helper refuses any other
// byte form of the same key (CRLF, different base64 wrapping, a PKCS#1
// "RSA PUBLIC KEY" block, surrounding comments) instead of letting the
// receipt's trustKeySha256 drift from the OTA lane.
//
// usage: CAPACITOR_LIVE_UPDATE_PUBLIC_KEY=... node trust-key.mjs
// stdout: the canonical sha256 (64 hex). Never prints the key.

import { createHash, createPublicKey } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function canonicalTrustKey(value) {
  if (typeof value !== "string") throw new Error("CAPACITOR_LIVE_UPDATE_PUBLIC_KEY is empty");
  // Same normalization as resolve-live-update-public-key.mjs normalizePem().
  const configured = value.trim().replace(/\\n/g, "\n");
  if (!configured) throw new Error("CAPACITOR_LIVE_UPDATE_PUBLIC_KEY is empty");
  let key;
  try {
    key = createPublicKey(configured);
  } catch {
    throw new Error("CAPACITOR_LIVE_UPDATE_PUBLIC_KEY is not a parseable public key");
  }
  if (key.asymmetricKeyType !== "rsa" || !(key.asymmetricKeyDetails?.modulusLength >= 2048)) {
    throw new Error("CAPACITOR_LIVE_UPDATE_PUBLIC_KEY must be an RSA (>=2048) public key");
  }
  const canonical = key.export({ type: "spki", format: "pem" }).toString().trim();
  if (configured !== canonical) {
    throw new Error(
      "CAPACITOR_LIVE_UPDATE_PUBLIC_KEY is not in canonical SPKI PEM form (LF line endings, 64-column base64, " +
        "BEGIN PUBLIC KEY); re-enter it as printed by resolve-live-update-public-key.mjs --print",
    );
  }
  return { pem: canonical, sha256: createHash("sha256").update(canonical).digest("hex") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${canonicalTrustKey(process.env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY).sha256}\n`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : "invalid OTA trust key"}`);
    process.exitCode = 1;
  }
}

export { canonicalTrustKey };
