import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { normalizePem, pemFingerprint, verifyNativeConfig, verifyPublicKey } from "./verify-trust-anchor.mjs";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();

test("fingerprint matches the resolver: sha256 of the trimmed PEM with literal \\n expanded", () => {
  const escaped = rsa.trim().replace(/\n/gu, "\\n");
  assert.equal(normalizePem(escaped), rsa.trim());
  assert.equal(verifyPublicKey(`  ${escaped}  `).sha256, createHash("sha256").update(rsa.trim()).digest("hex"));
  assert.equal(pemFingerprint(rsa.trim()), verifyPublicKey(rsa).sha256);
});

test("requires a non-empty RSA SPKI public key", () => {
  assert.throws(() => verifyPublicKey(""), /is required/u);
  assert.throws(() => verifyPublicKey(ec), /RSA/u);
  assert.throws(() => verifyPublicKey("not a pem"), /SPKI/u);
});

test("the synced native config must trust exactly the variable's key on channel internal", () => {
  const config = { appId: "dev.instafy.studio", plugins: { LiveUpdate: { defaultChannel: "internal", autoUpdateStrategy: "none", publicKey: rsa.trim() } } };
  assert.equal(verifyNativeConfig(config, rsa).sha256, verifyPublicKey(rsa).sha256);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => verifyNativeConfig({ ...config, plugins: { LiveUpdate: { ...config.plugins.LiveUpdate, publicKey: other } } }, rsa), /different Live Update key/u);
  assert.throws(() => verifyNativeConfig({ ...config, plugins: { LiveUpdate: { ...config.plugins.LiveUpdate, defaultChannel: "stable" } } }, rsa), /channel/u);
  assert.throws(() => verifyNativeConfig({ ...config, plugins: { LiveUpdate: { ...config.plugins.LiveUpdate, autoUpdateStrategy: "background" } } }, rsa), /autoUpdateStrategy/u);
  assert.throws(() => verifyNativeConfig({ ...config, appId: "dev.other" }, rsa), /appId/u);
});
