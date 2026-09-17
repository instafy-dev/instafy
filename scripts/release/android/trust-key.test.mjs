import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalTrustKey, readGitHubFileCommand, resolverDigestMatches } from "./trust-key.mjs";

const HELPER = path.join(import.meta.dirname, "trust-key.mjs");
const RESOLVER = path.resolve(import.meta.dirname, "..", "..", "resolve-live-update-public-key.mjs");
const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const canonical = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const canonicalSha256 = crypto.createHash("sha256").update(canonical).digest("hex");

test("canonical SPKI PEM is accepted and fingerprinted like the OTA authority", () => {
  assert.deepEqual(canonicalTrustKey(canonical), { pem: canonical, sha256: canonicalSha256 });
  assert.equal(canonicalTrustKey(`\n${canonical}\n`).sha256, canonicalSha256);
  // GitHub variables often hold literal \n escapes; resolve-live-update-public-key expands them too.
  assert.equal(canonicalTrustKey(canonical.replace(/\n/g, "\\n")).sha256, canonicalSha256);
});

test("the same key in any non-canonical byte form is refused", () => {
  const body = canonical.split("\n").slice(1, -1).join("");
  const variants = {
    crlf: canonical.replace(/\n/g, "\r\n"),
    rewrapped: ["-----BEGIN PUBLIC KEY-----", body.match(/.{1,76}/g).join("\n"), "-----END PUBLIC KEY-----"].join("\n"),
    unwrapped: ["-----BEGIN PUBLIC KEY-----", body, "-----END PUBLIC KEY-----"].join("\n"),
    pkcs1: publicKey.export({ type: "pkcs1", format: "pem" }).toString().trim(),
    trailingSpaces: canonical.replace(/\n/g, " \n"),
  };
  for (const [name, value] of Object.entries(variants)) {
    // Each variant still parses to the same key...
    const reparsed = crypto.createPublicKey(value.replace(/\\n/g, "\n"));
    assert.equal(reparsed.export({ type: "spki", format: "pem" }).toString().trim(), canonical, name);
    // ...but would hash differently in resolve-live-update-public-key.mjs, so it is refused.
    assert.throws(() => canonicalTrustKey(value), /canonical SPKI PEM/u, name);
  }
});

test("non-RSA, short and empty keys are refused", () => {
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const short = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => canonicalTrustKey(ec), /RSA/u);
  assert.throws(() => canonicalTrustKey(short), /RSA/u);
  assert.throws(() => canonicalTrustKey("  "), /empty/u);
  assert.throws(() => canonicalTrustKey(undefined), /empty/u);
  assert.throws(() => canonicalTrustKey("not a key"), /parseable/u);
});

test("CLI digest equals the resolver's public_key_sha256 output for the accepted form", () => {
  const cli = spawnSync(process.execPath, [HELPER], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CAPACITOR_LIVE_UPDATE_PUBLIC_KEY: canonical },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), canonicalSha256);
  assert.doesNotMatch(cli.stdout + cli.stderr, /-----BEGIN/u);
  const rejected = spawnSync(process.execPath, [HELPER], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CAPACITOR_LIVE_UPDATE_PUBLIC_KEY: canonical.replace(/\n/g, "\r\n") },
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-trust-key-"));
  try {
    const output = path.join(dir, "output");
    const envFile = path.join(dir, "env");
    fs.writeFileSync(output, "");
    fs.writeFileSync(envFile, "");
    const resolved = spawnSync(process.execPath, [RESOLVER], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CAPACITOR_LIVE_UPDATE_PUBLIC_KEY: canonical, GITHUB_OUTPUT: output, GITHUB_ENV: envFile },
    });
    assert.equal(resolved.status, 0, resolved.stderr);
    const digest = fs.readFileSync(output, "utf8").match(/^public_key_sha256<<(\S+)\n([0-9a-f]{64})\n\1\n$/u)?.[2];
    assert.equal(digest, canonicalSha256);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  assert.doesNotMatch(rejected.stderr, /-----BEGIN/u);
});

test("GitHub output parsing does not depend on the resolver's exact heredoc layout", () => {
  const other = "f".repeat(64);
  // Heredoc (current resolver), name=value, and later entries overriding earlier ones.
  assert.equal(readGitHubFileCommand(`public_key_sha256<<EOF_1\n${canonicalSha256}\nEOF_1\n`, "public_key_sha256"), canonicalSha256);
  assert.equal(readGitHubFileCommand(`public_key_sha256=${canonicalSha256}\n`, "public_key_sha256"), canonicalSha256);
  assert.equal(
    readGitHubFileCommand(`public_key_sha256=${other}\nx<<D\npublic_key_sha256=${other}\nD\npublic_key_sha256<<E\n${canonicalSha256}\nE\n`, "public_key_sha256"),
    canonicalSha256,
  );
  assert.equal(readGitHubFileCommand("other=1\n", "public_key_sha256"), undefined);
  assert.throws(() => readGitHubFileCommand(`public_key_sha256<<EOF\n${canonicalSha256}\n`, "public_key_sha256"), /unterminated/u);
  assert.equal(resolverDigestMatches(`public_key_sha256=${canonicalSha256}\n`, canonicalSha256), true);
  assert.throws(() => resolverDigestMatches(`public_key_sha256=${other}\n`, canonicalSha256), /not the canonical SPKI PEM/u);
  assert.throws(() => resolverDigestMatches("", canonicalSha256), /no public_key_sha256/u);
});

test("CLI --resolver-output checks the real resolver's GITHUB_OUTPUT exactly as the workflow step does", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-trust-output-"));
  try {
    const output = path.join(dir, "output");
    const envFile = path.join(dir, "env");
    fs.writeFileSync(output, "unrelated=1\n");
    fs.writeFileSync(envFile, "");
    const env = { PATH: process.env.PATH, CAPACITOR_LIVE_UPDATE_PUBLIC_KEY: canonical, GITHUB_OUTPUT: output, GITHUB_ENV: envFile };
    const resolved = spawnSync(process.execPath, [RESOLVER], { encoding: "utf8", env });
    assert.equal(resolved.status, 0, resolved.stderr);
    const ok = spawnSync(process.execPath, [HELPER, "--resolver-output", output], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), canonicalSha256);
    // A later output of a different digest (e.g. a different key resolved) is refused.
    fs.appendFileSync(output, `public_key_sha256=${"0".repeat(64)}\n`);
    const mismatch = spawnSync(process.execPath, [HELPER, "--resolver-output", output], { encoding: "utf8", env });
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.stdout, "");
    assert.match(mismatch.stderr, /not the canonical SPKI PEM/u);
    const missing = path.join(dir, "empty");
    fs.writeFileSync(missing, "");
    const none = spawnSync(process.execPath, [HELPER, "--resolver-output", missing], { encoding: "utf8", env });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no public_key_sha256/u);
    const usage = spawnSync(process.execPath, [HELPER, "--bogus"], { encoding: "utf8", env });
    assert.equal(usage.status, 1);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});
