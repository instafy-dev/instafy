#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

function parseArgs(argv) {
  const options = new Set();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      options.add(arg);
    }
  }
  return options;
}

function normalizePem(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\n/g, "\n");
}

function readPemFromEnv({ inlineKey, fileKey }) {
  const inlineValue = normalizePem(process.env[inlineKey]);
  if (inlineValue) {
    return inlineValue;
  }

  const filePath = process.env[fileKey]?.trim();
  if (!filePath) {
    return undefined;
  }

  return normalizePem(fs.readFileSync(filePath, "utf8"));
}

function pemFingerprint(pem) {
  return crypto.createHash("sha256").update(pem).digest("hex");
}

function writeGitHubMultiline(targetPath, name, value) {
  if (!targetPath) {
    return;
  }
  const delimiter = `EOF_${crypto.randomUUID().replace(/-/g, "")}`;
  fs.appendFileSync(targetPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

const args = parseArgs(process.argv.slice(2));
const requirePrivateKey = args.has("--require-private-key");
const printResolvedKey = args.has("--print");

const privateKeyPem = readPemFromEnv({
  inlineKey: "OTA_SIGNING_PRIVATE_KEY",
  fileKey: "OTA_SIGNING_PRIVATE_KEY_FILE",
});
const configuredPublicKeyPem = readPemFromEnv({
  inlineKey: "CAPACITOR_LIVE_UPDATE_PUBLIC_KEY",
  fileKey: "CAPACITOR_LIVE_UPDATE_PUBLIC_KEY_FILE",
});

if (!privateKeyPem) {
  if (requirePrivateKey) {
    console.error(
      "[ota:key] OTA_SIGNING_PRIVATE_KEY is required for this build so native OTA trust stays aligned with the signing key."
    );
    process.exit(1);
  }

  if (!configuredPublicKeyPem) {
    console.error("[ota:key] no OTA signing key or public key configured; leaving Capacitor Live Update unsigned.");
    process.exit(0);
  }

  writeGitHubMultiline(process.env.GITHUB_ENV, "CAPACITOR_LIVE_UPDATE_PUBLIC_KEY", configuredPublicKeyPem);
  writeGitHubMultiline(
    process.env.GITHUB_OUTPUT,
    "public_key_sha256",
    pemFingerprint(configuredPublicKeyPem)
  );
  if (printResolvedKey) {
    process.stdout.write(`${configuredPublicKeyPem}\n`);
  }
  console.error("[ota:key] using configured CAPACITOR_LIVE_UPDATE_PUBLIC_KEY.");
  process.exit(0);
}

const derivedPublicKeyPem = normalizePem(
  crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({
    format: "pem",
    type: "spki",
  })
);

if (!derivedPublicKeyPem) {
  console.error("[ota:key] failed to derive a public key from OTA_SIGNING_PRIVATE_KEY.");
  process.exit(1);
}

if (configuredPublicKeyPem && configuredPublicKeyPem !== derivedPublicKeyPem) {
  console.error(
    `[ota:key] CAPACITOR_LIVE_UPDATE_PUBLIC_KEY does not match OTA_SIGNING_PRIVATE_KEY.\n` +
      `  configured sha256: ${pemFingerprint(configuredPublicKeyPem)}\n` +
      `  derived    sha256: ${pemFingerprint(derivedPublicKeyPem)}`
  );
  process.exit(1);
}

writeGitHubMultiline(process.env.GITHUB_ENV, "CAPACITOR_LIVE_UPDATE_PUBLIC_KEY", derivedPublicKeyPem);
writeGitHubMultiline(process.env.GITHUB_OUTPUT, "public_key_sha256", pemFingerprint(derivedPublicKeyPem));

if (printResolvedKey) {
  process.stdout.write(`${derivedPublicKeyPem}\n`);
}

console.error("[ota:key] resolved CAPACITOR_LIVE_UPDATE_PUBLIC_KEY from OTA_SIGNING_PRIVATE_KEY.");
