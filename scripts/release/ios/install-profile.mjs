#!/usr/bin/env node
// Verify and install the exact IOS_APP_STORE provisioning profile selected by
// `asc.mjs download-profile`. The CMS envelope must carry one trusted signer;
// the signed payload (not the API metadata) must bind UUID, name, team, app id,
// expiry and the imported Apple Distribution certificate. The profile is then
// created exclusively (O_EXCL, 0600) in Xcode's per-user profile store and its
// cleanup target is recorded in GITHUB_ENV before any byte is written.
//
// usage: install-profile.mjs <profile-metadata.json>
// env:   IOS_SIGNING_KEYCHAIN, IOS_DEVELOPMENT_TEAM, IOS_DIST_CERT_SHA256,
//        APP_BUNDLE_ID, RUNNER_TEMP, HOME, GITHUB_ENV

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
export const PROFILE_STORE = "Library/Developer/Xcode/UserData/Provisioning Profiles";

function fail(code) {
  throw new Error(`[ios-profile] validation failed at ${code}`);
}

export function validateProfileMetadata(metadata, { bundleId, certSha256 }) {
  if (!metadata || typeof metadata !== "object") fail("provider-metadata");
  if (metadata.provider !== "app-store-connect" || metadata.profileType !== "IOS_APP_STORE") {
    fail("provider-profile-type");
  }
  if (metadata.bundleId !== bundleId) fail("provider-bundle-binding");
  if (metadata.certificateSha256 !== certSha256) fail("provider-certificate-binding");
  if (typeof metadata.uuid !== "string" || !UUID.test(metadata.uuid)) fail("provider-uuid");
  if (typeof metadata.name !== "string" || metadata.name.length === 0) fail("provider-name");
  if (!Number.isFinite(Date.parse(metadata.expirationDate))) fail("provider-expiration");
  if (typeof metadata.profileContent !== "string") fail("provider-profile-content");
  const bytes = Buffer.from(metadata.profileContent, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_PROFILE_BYTES ||
    bytes.toString("base64") !== metadata.profileContent
  ) {
    fail("provider-profile-content");
  }
  return bytes;
}

export function validateCmsStatus(text) {
  const layers = [...String(text).matchAll(/type=signedData; nsigners=([0-9]+);/gu)];
  const signers = [...String(text).matchAll(/signer([0-9]+)[.]status=([^;\r\n]+);/gu)];
  if (
    layers.length !== 1 ||
    layers[0][1] !== "1" ||
    signers.length !== 1 ||
    signers[0][1] !== "0" ||
    signers[0][2] !== "GoodSignature"
  ) {
    fail("cms-signer-status");
  }
  return true;
}

// `payload` is the signed plist as JSON (dates as ISO strings, data as base64).
export function validateSignedProfile(payload, { metadata, team, bundleId, certSha256, now = new Date() }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("signed-profile-shape");
  if (Object.hasOwn(payload, "IsXcodeManaged") && payload.IsXcodeManaged !== false) {
    fail("signed-profile-xcode-managed");
  }
  const uuid = payload.UUID;
  if (typeof uuid !== "string" || !UUID.test(uuid)) fail("signed-uuid-format");
  if (uuid.toUpperCase() !== metadata.uuid.toUpperCase()) fail("signed-uuid-binding");
  if (payload.Name !== metadata.name) fail("signed-name-binding");
  if (!Array.isArray(payload.TeamIdentifier) || payload.TeamIdentifier[0] !== team) {
    fail("signed-team-binding");
  }
  const prefix = Array.isArray(payload.ApplicationIdentifierPrefix)
    ? payload.ApplicationIdentifierPrefix[0]
    : undefined;
  const entitlements = payload.Entitlements;
  if (typeof prefix !== "string" || !/^[A-Z0-9]{10}$/u.test(prefix)) fail("signed-application-prefix");
  if (entitlements?.["application-identifier"] !== `${prefix}.${bundleId}`) {
    fail("signed-application-binding");
  }
  if (entitlements?.["get-task-allow"] !== false) fail("signed-debug-policy");
  if (Object.hasOwn(payload, "ProvisionedDevices") || Object.hasOwn(payload, "ProvisionsAllDevices")) {
    fail("signed-distribution-policy");
  }
  const signedExpiry = Date.parse(payload.ExpirationDate);
  if (
    !Number.isFinite(signedExpiry) ||
    signedExpiry !== Date.parse(metadata.expirationDate) ||
    signedExpiry <= now.getTime()
  ) {
    fail("signed-expiration-binding");
  }
  const certificates = payload.DeveloperCertificates;
  if (!Array.isArray(certificates) || certificates.length === 0) fail("signed-certificate-binding");
  // DeveloperCertificates are DER certificates; match on their SHA-256 fingerprint.
  const matches = certificates.filter((value) =>
    typeof value === "string" &&
    createHash("sha256").update(Buffer.from(value, "base64")).digest("hex") === certSha256);
  if (matches.length !== 1) fail("signed-certificate-binding");
  return uuid;
}

const PLIST_TO_JSON = String.raw`
import base64, datetime, json, plistlib, sys
class UniqueKeys(dict):
    def __setitem__(self, key, value):
        if key in self:
            raise ValueError("duplicate plist key")
        super().__setitem__(key, value)
def convert(value):
    if isinstance(value, dict):
        return {k: convert(v) for k, v in value.items()}
    if isinstance(value, list):
        return [convert(v) for v in value]
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=datetime.timezone.utc)
        return value.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return value
payload = plistlib.loads(sys.stdin.buffer.read(), dict_type=UniqueKeys)
sys.stdout.write(json.dumps(convert(payload)))
`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`environment-${name}`);
  return value;
}

function installExclusive({ bytes, directory, uuid, githubEnv }) {
  let current = directory;
  while (current !== path.dirname(current)) {
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("profile-install-directory");
    current = path.dirname(current);
  }
  const clash = fs.readdirSync(directory).filter(
    (name) => name.toUpperCase() === `${uuid}.mobileprovision`.toUpperCase(),
  );
  if (clash.length !== 0) fail("profile-install-path");
  const target = path.join(directory, `${uuid}.mobileprovision`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // Persist ownership first so the always() cleanup removes even a partial file.
    fs.appendFileSync(
      githubEnv,
      `IOS_APP_STORE_PROFILE_UUID=${uuid}\nIOS_APP_STORE_PROFILE_PATH=${target}\nIOS_APP_STORE_PROFILE_SHA256=${digest}\n`,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const info = fs.lstatSync(target);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || !fs.readFileSync(target).equals(bytes)) {
    fail("profile-install-readback");
  }
  return target;
}

function main(argv) {
  if (argv.length !== 1) fail("usage");
  const keychain = requireEnv("IOS_SIGNING_KEYCHAIN");
  const team = requireEnv("IOS_DEVELOPMENT_TEAM");
  const certSha256 = requireEnv("IOS_DIST_CERT_SHA256");
  const bundleId = requireEnv("APP_BUNDLE_ID");
  const githubEnv = requireEnv("GITHUB_ENV");
  if (!/^[0-9a-f]{64}$/u.test(certSha256) || !/^[A-Z0-9]{10}$/u.test(team)) fail("inputs");
  const metadata = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  const bytes = validateProfileMetadata(metadata, { bundleId, certSha256 });
  const work = fs.mkdtempSync(path.join(requireEnv("RUNNER_TEMP"), "instafy-ios-profile."));
  try {
    const downloaded = path.join(work, "profile.mobileprovision");
    fs.writeFileSync(downloaded, bytes, { mode: 0o600, flag: "wx" });
    // Plain `security cms -D` decodes even when signer verification fails, so
    // require the explicit trust-evaluated status first.
    validateCmsStatus(execFileSync(
      "security",
      ["cms", "-D", "-i", downloaded, "-k", keychain, "-h", "0", "-n"],
      { encoding: "utf8" },
    ));
    const signedPlist = execFileSync("security", ["cms", "-D", "-i", downloaded, "-k", keychain]);
    const payload = JSON.parse(execFileSync("python3", ["-c", PLIST_TO_JSON], {
      input: signedPlist,
      encoding: "utf8",
    }));
    const uuid = validateSignedProfile(payload, { metadata, team, bundleId, certSha256 });
    const store = path.join(requireEnv("HOME"), PROFILE_STORE);
    fs.mkdirSync(store, { recursive: true });
    const target = installExclusive({ bytes, directory: store, uuid, githubEnv });
    console.log(`[ios-profile] installed one exact signed App Store profile at ${path.basename(target)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("[ios-profile]")
      ? error.message
      : "[ios-profile] validation failed at profile-observation";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
