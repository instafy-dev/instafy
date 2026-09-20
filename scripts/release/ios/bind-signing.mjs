#!/usr/bin/env node
// Bind manual App Store signing to ONLY the App target's Release configuration
// by editing the checked-out project.pbxproj with PlistBuddy, then prove the
// edit is exactly those five settings and that xcodebuild resolves them.
// Signing settings are never passed on the xcodebuild command line: SwiftPM
// resource-bundle targets would inherit them and fail to build.
//
// env: IOS_PROJECT, IOS_SCHEME, APP_BUNDLE_ID, IOS_DEVELOPMENT_TEAM,
//      IOS_DIST_CERT_SHA1, IOS_SIGNING_KEYCHAIN, IOS_APP_STORE_PROFILE_UUID,
//      IOS_SWIFTPM_ROOT, RUNNER_TEMP

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const SIGNING_KEYS = [
  "CODE_SIGN_IDENTITY",
  "OTHER_CODE_SIGN_FLAGS",
  "PROVISIONING_PROFILE",
  "PROVISIONING_PROFILE_SPECIFIER",
];

function fail(code) {
  throw new Error(`[ios-bind-signing] failed at ${code}`);
}

export function validateSigningInputs(inputs) {
  const { scheme, bundleId, team, certSha1, keychain, profileUuid } = inputs;
  if (typeof scheme !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(scheme)) fail("scheme");
  if (typeof bundleId !== "string" || !/^[A-Za-z0-9.-]{3,200}$/u.test(bundleId)) fail("bundle-id");
  if (typeof team !== "string" || !/^[A-Z0-9]{10}$/u.test(team)) fail("team");
  if (typeof certSha1 !== "string" || !/^[0-9a-f]{40}$/u.test(certSha1)) fail("certificate");
  if (
    typeof keychain !== "string" ||
    !path.isAbsolute(keychain) ||
    !/^[A-Za-z0-9/._-]+\/instafy-ios-signing\.keychain-db$/u.test(keychain)
  ) {
    fail("keychain");
  }
  if (
    typeof profileUuid !== "string" ||
    !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u.test(profileUuid)
  ) {
    fail("profile-uuid");
  }
  return inputs;
}

export function findAppReleaseConfiguration(project, { scheme, bundleId }) {
  const objects = project?.objects;
  if (!objects || typeof objects !== "object" || Array.isArray(objects)) fail("project-objects");
  const appTargets = Object.values(objects).filter(
    (value) =>
      value?.isa === "PBXNativeTarget" &&
      value?.name === scheme &&
      value?.productType === "com.apple.product-type.application",
  );
  if (appTargets.length !== 1) fail("app-target");
  const configurationList = objects[appTargets[0].buildConfigurationList];
  const configurationIds = configurationList?.buildConfigurations;
  if (
    configurationList?.isa !== "XCConfigurationList" ||
    !Array.isArray(configurationIds) ||
    new Set(configurationIds).size !== configurationIds.length
  ) {
    fail("app-configuration-list");
  }
  const releaseIds = configurationIds.filter(
    (id) => objects[id]?.isa === "XCBuildConfiguration" && objects[id]?.name === "Release",
  );
  if (releaseIds.length !== 1) fail("app-release-configuration");
  const releaseId = releaseIds[0];
  if (!/^[A-Fa-f0-9]{24}$/u.test(releaseId)) fail("configuration-id");
  const settings = objects[releaseId]?.buildSettings;
  if (!settings || typeof settings !== "object") fail("app-release-settings");
  if (
    settings.CODE_SIGN_STYLE !== "Automatic" ||
    settings.DEVELOPMENT_TEAM !== "" ||
    SIGNING_KEYS.some((key) => Object.hasOwn(settings, key)) ||
    settings.CODE_SIGN_ENTITLEMENTS !== "App/App.release.entitlements" ||
    settings.PRODUCT_BUNDLE_IDENTIFIER !== bundleId
  ) {
    fail("unexpected-app-release-signing-state");
  }
  return releaseId;
}

export function planSigningBinding(project, inputs) {
  validateSigningInputs(inputs);
  const id = findAppReleaseConfiguration(project, inputs);
  const base = `:objects:${id}:buildSettings`;
  return {
    configurationId: id,
    commands: [
      `Set ${base}:CODE_SIGN_STYLE Manual`,
      `Set ${base}:DEVELOPMENT_TEAM ${inputs.team}`,
      `Add ${base}:CODE_SIGN_IDENTITY string ${inputs.certSha1}`,
      `Add ${base}:OTHER_CODE_SIGN_FLAGS string --keychain ${inputs.keychain}`,
      `Add ${base}:PROVISIONING_PROFILE_SPECIFIER string ${inputs.profileUuid}`,
    ],
  };
}

// The signed project must differ from the original by exactly the five
// Release settings of the App target.
export function verifySignedProject(original, signed, configurationId, inputs) {
  const signedSettings = signed?.objects?.[configurationId]?.buildSettings;
  if (!original?.objects?.[configurationId]?.buildSettings || !signedSettings) {
    fail("signed-release-settings");
  }
  if (
    signedSettings.CODE_SIGN_STYLE !== "Manual" ||
    signedSettings.CODE_SIGN_IDENTITY !== inputs.certSha1 ||
    signedSettings.DEVELOPMENT_TEAM !== inputs.team ||
    signedSettings.OTHER_CODE_SIGN_FLAGS !== `--keychain ${inputs.keychain}` ||
    signedSettings.PROVISIONING_PROFILE_SPECIFIER !== inputs.profileUuid
  ) {
    fail("signed-release-values");
  }
  const normalized = structuredClone(signed);
  const settings = normalized.objects[configurationId].buildSettings;
  settings.CODE_SIGN_STYLE = "Automatic";
  settings.DEVELOPMENT_TEAM = "";
  delete settings.CODE_SIGN_IDENTITY;
  delete settings.OTHER_CODE_SIGN_FLAGS;
  delete settings.PROVISIONING_PROFILE_SPECIFIER;
  try {
    assert.deepEqual(normalized, original);
  } catch {
    fail("project-semantic-diff");
  }
  return true;
}

export function verifyResolvedBuildSettings(resolved, inputs) {
  const settings = Array.isArray(resolved) && resolved.length === 1
    ? resolved[0]?.buildSettings
    : null;
  if (
    !settings ||
    resolved[0].target !== inputs.scheme ||
    settings.CODE_SIGN_STYLE !== "Manual" ||
    settings.DEVELOPMENT_TEAM !== inputs.team ||
    settings.PRODUCT_BUNDLE_IDENTIFIER !== inputs.bundleId ||
    settings.CODE_SIGN_IDENTITY !== inputs.certSha1 ||
    settings.PROVISIONING_PROFILE_SPECIFIER !== inputs.profileUuid ||
    (settings.PROVISIONING_PROFILE ?? "") !== "" ||
    settings.OTHER_CODE_SIGN_FLAGS !== `--keychain ${inputs.keychain}`
  ) {
    fail("resolved-build-settings");
  }
  return true;
}

function plistToJson(file) {
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", file], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

function main() {
  const env = process.env;
  const inputs = validateSigningInputs({
    scheme: env.IOS_SCHEME,
    bundleId: env.APP_BUNDLE_ID,
    team: env.IOS_DEVELOPMENT_TEAM,
    certSha1: env.IOS_DIST_CERT_SHA1,
    keychain: env.IOS_SIGNING_KEYCHAIN,
    profileUuid: env.IOS_APP_STORE_PROFILE_UUID,
  });
  const projectDir = path.resolve(env.IOS_PROJECT ?? "");
  const projectFile = path.join(projectDir, "project.pbxproj");
  const info = fs.lstatSync(projectFile);
  if (fs.lstatSync(projectDir).isSymbolicLink() || !info.isFile() || info.isSymbolicLink()) {
    fail("project-path");
  }
  const original = plistToJson(projectFile);
  const plan = planSigningBinding(original, inputs);
  execFileSync(
    PLIST_BUDDY,
    [...plan.commands.flatMap((command) => ["-c", command]), projectFile],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  verifySignedProject(original, plistToJson(projectFile), plan.configurationId, inputs);
  const swiftpm = env.IOS_SWIFTPM_ROOT;
  const resolved = JSON.parse(
    execFileSync(
      "xcodebuild",
      [
        "-project", projectDir,
        "-target", inputs.scheme,
        "-configuration", "Release",
        "-sdk", "iphoneos",
        ...(swiftpm
          ? [
            "-clonedSourcePackagesDirPath", path.join(swiftpm, "checkouts"),
            "-packageCachePath", path.join(swiftpm, "cache"),
            "-disablePackageRepositoryCache",
          ]
          : []),
        "-showBuildSettings",
        "-json",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  verifyResolvedBuildSettings(resolved, inputs);
  console.log(
    `[ios-bind-signing] bound manual signing to ${inputs.scheme}/Release (${plan.configurationId}) only`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("[ios-bind-signing]")
      ? error.message
      : "[ios-bind-signing] failed";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
