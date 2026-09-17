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
// usage: CAPACITOR_LIVE_UPDATE_PUBLIC_KEY=... node trust-key.mjs [--resolver-output <GITHUB_OUTPUT>]
// stdout: the canonical sha256 (64 hex). Never prints the key.
// --resolver-output: also require the last public_key_sha256 that
// resolve-live-update-public-key.mjs wrote to that file (heredoc or name=value
// form, parsed like the runner does) to equal the canonical digest.

import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
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

// Last value of `name` in a GitHub Actions file command (GITHUB_OUTPUT/GITHUB_ENV),
// accepting both `name=value` and `name<<DELIMITER ... DELIMITER` entries.
function readGitHubFileCommand(text, name) {
  const lines = String(text).split("\n");
  let value;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredoc = /^([^=<]+)<<(.+)$/u.exec(line);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], index + 1);
      if (end === -1) throw new Error(`unterminated ${heredoc[1]} entry in the GitHub output file`);
      if (heredoc[1] === name) value = lines.slice(index + 1, end).join("\n");
      index = end;
      continue;
    }
    const assignment = /^([^=]+)=(.*)$/u.exec(line);
    if (assignment && assignment[1] === name) value = assignment[2];
  }
  return value;
}

function resolverDigestMatches(outputText, sha256) {
  const resolved = readGitHubFileCommand(outputText, "public_key_sha256");
  if (resolved === undefined) throw new Error("resolve-live-update-public-key.mjs wrote no public_key_sha256 output");
  if (resolved !== sha256) throw new Error("The resolved OTA trust key is not the canonical SPKI PEM.");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const { sha256 } = canonicalTrustKey(process.env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY);
    if (args.length > 0) {
      if (args.length !== 2 || args[0] !== "--resolver-output") throw new Error("usage: trust-key.mjs [--resolver-output <file>]");
      resolverDigestMatches(fs.readFileSync(args[1], "utf8"), sha256);
    }
    process.stdout.write(`${sha256}\n`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : "invalid OTA trust key"}`);
    process.exitCode = 1;
  }
}

export { canonicalTrustKey, readGitHubFileCommand, resolverDigestMatches };
