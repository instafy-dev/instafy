#!/usr/bin/env node
// OTA trust anchor checks for the native shell.
//
//   verify-trust-anchor.mjs key
//     CAPACITOR_LIVE_UPDATE_PUBLIC_KEY (repository variable) must be a
//     non-empty RSA SPKI PEM; prints its fingerprint.
//   verify-trust-anchor.mjs config <capacitor.config.json>
//     the synced native config must trust exactly that PEM on channel
//     "internal" with autoUpdateStrategy "none".
//
// The fingerprint is sha256 of the normalized PEM (trim, literal \n expanded),
// identical to scripts/resolve-live-update-public-key.mjs pemFingerprint.

import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PUBLIC_HEADER = ["-----BEGIN", "PUBLIC KEY-----"].join(" ");

function fail(message) {
  throw new Error(`[ios-trust-anchor] ${message}`);
}

export function normalizePem(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.replace(/\\n/gu, "\n") : undefined;
}

export function pemFingerprint(pem) {
  return createHash("sha256").update(pem).digest("hex");
}

export function verifyPublicKey(raw) {
  const pem = normalizePem(raw);
  if (!pem) fail("CAPACITOR_LIVE_UPDATE_PUBLIC_KEY repository variable is required");
  if (!pem.startsWith(PUBLIC_HEADER)) fail("the Live Update key must be an SPKI public key PEM");
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    fail("the Live Update key is not a parseable public key");
  }
  if (key.asymmetricKeyType !== "rsa") fail("the Live Update key must be an RSA key");
  return { pem, sha256: pemFingerprint(pem) };
}

export function verifyNativeConfig(config, raw, { appId = "dev.instafy.studio", channel = "internal" } = {}) {
  const { pem, sha256 } = verifyPublicKey(raw);
  const liveUpdate = config?.plugins?.LiveUpdate;
  if (config?.appId !== appId) fail("native config appId differs");
  if (liveUpdate?.defaultChannel !== channel) fail("native config channel differs");
  if (liveUpdate?.autoUpdateStrategy !== "none") fail("native config autoUpdateStrategy must be none");
  if (normalizePem(liveUpdate?.publicKey) !== pem) {
    fail("the synced native shell trusts a different Live Update key");
  }
  return { sha256 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [command, file] = process.argv.slice(2);
    const raw = process.env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY;
    if (command === "key" && file === undefined) {
      console.log(verifyPublicKey(raw).sha256);
    } else if (command === "config" && file) {
      console.log(verifyNativeConfig(JSON.parse(fs.readFileSync(file, "utf8")), raw).sha256);
    } else {
      fail("usage: verify-trust-anchor.mjs key | config <capacitor.config.json>");
    }
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("[ios-trust-anchor]")
      ? error.message
      : "[ios-trust-anchor] verification failed";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
