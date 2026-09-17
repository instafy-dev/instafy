import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validateCmsStatus, validateProfileMetadata, validateSignedProfile } from "./install-profile.mjs";

const CERT = Buffer.from("fixture distribution certificate");
const CERT_SHA1 = createHash("sha1").update(CERT).digest("hex");
const UUID = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-09-17T00:00:00Z");
const metadata = {
  schemaVersion: 1,
  provider: "app-store-connect",
  bundleId: "dev.instafy.studio",
  profileId: "4ABCDEF",
  name: "Instafy App Store",
  uuid: UUID,
  profileType: "IOS_APP_STORE",
  expirationDate: "2027-09-02T12:00:00.000Z",
  profileContent: Buffer.from("signed profile bytes").toString("base64"),
  certificateId: "certificate-1",
  certificateSha1: CERT_SHA1,
};
const payload = {
  UUID: UUID.toLowerCase(),
  Name: "Instafy App Store",
  TeamIdentifier: ["ABCDE12345"],
  ApplicationIdentifierPrefix: ["ABCDE12345"],
  Entitlements: { "application-identifier": "ABCDE12345.dev.instafy.studio", "get-task-allow": false },
  ExpirationDate: "2027-09-02T12:00:00Z",
  DeveloperCertificates: [CERT.toString("base64")],
  IsXcodeManaged: false,
};
const context = { metadata, team: "ABCDE12345", bundleId: "dev.instafy.studio", certSha1: CERT_SHA1, now: NOW };

test("provider metadata must name the exact bundle, certificate and profile type", () => {
  assert.deepEqual(validateProfileMetadata(metadata, context), Buffer.from("signed profile bytes"));
  assert.throws(() => validateProfileMetadata({ ...metadata, bundleId: "dev.other" }, context), /provider-bundle-binding/u);
  assert.throws(() => validateProfileMetadata({ ...metadata, certificateSha1: "0".repeat(40) }, context), /provider-certificate-binding/u);
  assert.throws(() => validateProfileMetadata({ ...metadata, profileType: "IOS_APP_DEVELOPMENT" }, context), /provider-profile-type/u);
  assert.throws(() => validateProfileMetadata({ ...metadata, profileContent: "not base64!" }, context), /provider-profile-content/u);
});

test("CMS status needs exactly one trusted signer", () => {
  assert.equal(validateCmsStatus("level0.type=signedData; nsigners=1;\nsigner0.status=GoodSignature;\n"), true);
  assert.throws(() => validateCmsStatus("type=signedData; nsigners=1;\nsigner0.status=SigningCertNotTrusted;\n"), /cms-signer-status/u);
  assert.throws(() => validateCmsStatus("type=signedData; nsigners=2;\nsigner0.status=GoodSignature;\nsigner1.status=GoodSignature;\n"), /cms-signer-status/u);
  assert.throws(() => validateCmsStatus(""), /cms-signer-status/u);
});

test("the signed payload binds UUID, team, app id, distribution policy, expiry and certificate", () => {
  assert.equal(validateSignedProfile(payload, context), UUID.toLowerCase());
  const cases = [
    [{ UUID: "99999999-2222-3333-4444-555555555555" }, /signed-uuid-binding/u],
    [{ Name: "Other" }, /signed-name-binding/u],
    [{ TeamIdentifier: ["ZZZZZ99999"] }, /signed-team-binding/u],
    [{ Entitlements: { ...payload.Entitlements, "application-identifier": "ABCDE12345.dev.other" } }, /signed-application-binding/u],
    [{ Entitlements: { ...payload.Entitlements, "get-task-allow": true } }, /signed-debug-policy/u],
    [{ ProvisionedDevices: ["device"] }, /signed-distribution-policy/u],
    [{ ProvisionsAllDevices: true }, /signed-distribution-policy/u],
    [{ ExpirationDate: "2027-09-03T12:00:00Z" }, /signed-expiration-binding/u],
    [{ DeveloperCertificates: [Buffer.from("other").toString("base64")] }, /signed-certificate-binding/u],
    [{ DeveloperCertificates: [CERT.toString("base64"), CERT.toString("base64")] }, /signed-certificate-binding/u],
    [{ IsXcodeManaged: true }, /signed-profile-xcode-managed/u],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => validateSignedProfile({ ...payload, ...override }, context), expected, JSON.stringify(override));
  }
  assert.throws(
    () => validateSignedProfile(payload, { ...context, now: new Date("2028-01-01T00:00:00Z") }),
    /signed-expiration-binding/u,
  );
});
