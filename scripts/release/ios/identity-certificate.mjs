#!/usr/bin/env node
// Resolve the SHA-256 DER fingerprint of the Apple Distribution identity that
// `security find-identity` selected, from every certificate in the isolated
// keychain (`security find-certificate -a -p <keychain>`).
//
// Selection is by the identity's exact SHA-1 (what find-identity prints), never
// by common name, so intermediates, same-named certificates and PEM formatting
// differences cannot make the step pick or reject the wrong certificate. The name
// and team binding is already checked on the find-identity line itself (subject
// strings are not compared here: their escaping differs between tools).
//
// usage: identity-certificate.mjs <pem-file> <identity-sha1>
//        (prints the lowercase SHA-256 of the identity certificate's DER)

import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/gu;

function hex(fingerprint) {
  return fingerprint.replaceAll(":", "").toLowerCase();
}

export function parseCertificates(pemText) {
  const certificates = [];
  for (const match of pemText.matchAll(PEM_BLOCK)) {
    const der = Buffer.from(match[1].replace(/\s/gu, ""), "base64");
    certificates.push(new X509Certificate(der));
  }
  return certificates;
}

export function resolveIdentityCertificate(pemText, identitySha1) {
  if (!/^[0-9a-f]{40}$/u.test(identitySha1 ?? "")) throw new Error("identity SHA-1 must be 40 lowercase hex characters");
  const certificates = parseCertificates(pemText);
  if (certificates.length === 0) throw new Error("the keychain holds no certificates");
  const matches = new Map();
  for (const certificate of certificates) {
    if (hex(certificate.fingerprint) === identitySha1) {
      matches.set(hex(certificate.fingerprint256), certificate);
    }
  }
  if (matches.size !== 1) {
    throw new Error(`exactly one keychain certificate must match the identity SHA-1 (found ${matches.size})`);
  }
  const [[sha256]] = matches;
  return sha256;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [pemFile, identitySha1] = process.argv.slice(2);
  try {
    if (!pemFile) throw new Error("usage: identity-certificate.mjs <pem-file> <identity-sha1>");
    process.stdout.write(`${resolveIdentityCertificate(fs.readFileSync(pemFile, "utf8"), identitySha1)}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}
