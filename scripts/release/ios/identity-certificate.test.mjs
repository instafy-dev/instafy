import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveIdentityCertificate } from "./identity-certificate.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "identity-certificate.mjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ios-identity-certificate-"));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

// Certificates are generated per run; nothing key-shaped is committed.
function certificate(name, commonName) {
  const pem = path.join(directory, `${name}.pem`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", path.join(directory, `${name}.key`), "-out", pem, "-days", "2", "-subj", `/CN=${commonName}/OU=ABCDE12345`,
  ], { stdio: "ignore" });
  const text = fs.readFileSync(pem, "utf8");
  const x509 = new X509Certificate(text);
  return {
    text,
    sha1: x509.fingerprint.replaceAll(":", "").toLowerCase(),
    sha256: x509.fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

const identity = certificate("identity", "Apple Distribution: Fixture Team (ABCDE12345)");
const sameName = certificate("same-name", "Apple Distribution: Fixture Team (ABCDE12345)");
const intermediate = certificate("intermediate", "Apple Worldwide Developer Relations Certification Authority");

test("selects the identity certificate by exact SHA-1 among intermediates and same-named certificates", () => {
  const keychain = [intermediate.text, sameName.text, identity.text].join("");
  assert.equal(resolveIdentityCertificate(keychain, identity.sha1), identity.sha256);
  assert.equal(resolveIdentityCertificate(keychain, sameName.sha1), sameName.sha256);
  assert.notEqual(identity.sha256, sameName.sha256);
});

test("tolerates security's PEM layout variations and duplicate listings of one certificate", () => {
  const crlf = identity.text.replace(/\n/gu, "\r\n");
  const noise = `keychain: "/tmp/x.keychain-db"\n${intermediate.text}\n\n${crlf}${identity.text}`;
  assert.equal(resolveIdentityCertificate(noise, identity.sha1), identity.sha256);
});

test("fails closed when the identity certificate is absent or the SHA-1 is malformed", () => {
  assert.throws(() => resolveIdentityCertificate(intermediate.text, identity.sha1), /found 0/u);
  assert.throws(() => resolveIdentityCertificate("", identity.sha1), /no certificates/u);
  assert.throws(() => resolveIdentityCertificate(identity.text, identity.sha1.toUpperCase()), /40 lowercase hex/u);
  assert.throws(() => resolveIdentityCertificate(identity.text, undefined), /40 lowercase hex/u);
});

test("CLI prints only the SHA-256 and exits non-zero without a match", () => {
  const file = path.join(directory, "keychain.pem");
  fs.writeFileSync(file, `${intermediate.text}${identity.text}`);
  assert.equal(execFileSync(process.execPath, [script, file, identity.sha1], { encoding: "utf8" }), `${identity.sha256}\n`);
  assert.throws(() => execFileSync(process.execPath, [script, file, sameName.sha1], { stdio: "pipe" }), /found 0/u);
});
