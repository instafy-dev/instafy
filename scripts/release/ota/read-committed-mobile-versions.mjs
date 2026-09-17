#!/usr/bin/env node
// Reads the native compatibility tuple committed at the release commit. An
// OTA bundle is registered with required_native_build equal to these values,
// so they must come from source, never from workflow inputs.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const IOS_PROJECT = "packages/frontend/ios/App/App.xcodeproj/project.pbxproj";
export const ANDROID_BUILD = "packages/frontend/android/app/build.gradle";
export const APPLICATION_ID = "dev.instafy.studio";

const IOS_MARKETING = /^[0-9]+(?:\.[0-9]+){1,3}$/u;
const IOS_BUILD = /^[1-9][0-9]*$/u;
const ANDROID_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;
const ANDROID_CODE = /^[1-9][0-9]{0,9}$/u;

function fail(message) {
  throw new Error(message);
}

function lineValues(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function oneConsistentValue(values, label) {
  if (values.length === 0 || new Set(values).size !== 1) {
    fail(`${label} must have one consistent committed value`);
  }
  return values[0];
}

function exactlyOne(values, label) {
  if (values.length !== 1) {
    fail(`${label} must be declared exactly once`);
  }
  return values[0];
}

export function parseCommittedMobileVersions({ pbxproj, gradle }) {
  const marketingVersion = oneConsistentValue(
    lineValues(pbxproj, /^\s*MARKETING_VERSION\s*=\s*([^;\s]+)\s*;\s*$/gmu),
    "iOS MARKETING_VERSION",
  );
  const buildNumber = oneConsistentValue(
    lineValues(pbxproj, /^\s*CURRENT_PROJECT_VERSION\s*=\s*([^;\s]+)\s*;\s*$/gmu),
    "iOS CURRENT_PROJECT_VERSION",
  );
  const bundleIds = lineValues(pbxproj, /^\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s]+)\s*;\s*$/gmu);
  if (
    !bundleIds.includes(APPLICATION_ID) ||
    bundleIds.some((value) => value !== APPLICATION_ID && value !== `${APPLICATION_ID}.uitests`)
  ) {
    fail(`iOS application identity must remain ${APPLICATION_ID}`);
  }
  if (!IOS_MARKETING.test(marketingVersion) || !IOS_BUILD.test(buildNumber)) {
    fail("iOS MARKETING_VERSION / CURRENT_PROJECT_VERSION have an unsupported shape");
  }

  const versionCode = exactlyOne(
    lineValues(gradle, /^\s*def\s+resolvedVersionCode\s*=\s*([1-9][0-9]*)\s*$/gmu),
    "Android resolvedVersionCode default",
  );
  const versionName = exactlyOne(
    lineValues(gradle, /^\s*def\s+resolvedVersionName\s*=\s*versionNameOverride\s*\?:\s*"([^"]+)"\s*$/gmu),
    "Android resolvedVersionName default",
  );
  const applicationId = exactlyOne(
    lineValues(gradle, /^\s*applicationId\s+"([^"]+)"\s*$/gmu),
    "Android applicationId",
  );
  if (applicationId !== APPLICATION_ID) {
    fail(`Android application identity must remain ${APPLICATION_ID}`);
  }
  if (
    lineValues(gradle, /^\s*versionCode\s+(\S+)\s*$/gmu).join("\0") !== "resolvedVersionCode" ||
    lineValues(gradle, /^\s*versionName\s+(\S+)\s*$/gmu).join("\0") !== "resolvedVersionName"
  ) {
    fail("Android defaultConfig must consume the resolved versions exactly once");
  }
  if (!ANDROID_NAME.test(versionName) || !ANDROID_CODE.test(versionCode)) {
    fail("Android versionName / versionCode have an unsupported shape");
  }

  return {
    ios: { marketingVersion, buildNumber },
    android: { versionName, versionCode },
  };
}

export function readCommittedMobileVersions(root) {
  const read = (relative) => {
    const file = path.join(root, relative);
    if (fs.lstatSync(file).isSymbolicLink()) {
      fail(`${relative} must not be a symbolic link`);
    }
    return fs.readFileSync(file, "utf8");
  };
  return parseCommittedMobileVersions({ pbxproj: read(IOS_PROJECT), gradle: read(ANDROID_BUILD) });
}

function main() {
  const root = path.resolve(process.argv[2] ?? ".");
  const versions = readCommittedMobileVersions(root);
  const lines = [
    `ios_marketing_version=${versions.ios.marketingVersion}`,
    `ios_build_number=${versions.ios.buildNumber}`,
    `android_version_name=${versions.android.versionName}`,
    `android_version_code=${versions.android.versionCode}`,
  ].join("\n");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  }
  process.stdout.write(`${lines}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
