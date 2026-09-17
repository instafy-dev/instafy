#!/usr/bin/env node
// Reads the committed Android release identity from the exact source tree.
// The Android release tag android-v<versionName>-<versionCode> must equal
// these values; the workflow never bumps them through environment overrides.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ANDROID_BUILD_GRADLE = "packages/frontend/android/app/build.gradle";
export const ANDROID_APPLICATION_ID = "dev.instafy.studio";
export const VERSION_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;
export const VERSION_CODE_PATTERN = /^[1-9][0-9]{0,9}$/u;
export const MAX_PLAY_VERSION_CODE = 2_100_000_000;

function fail(message) {
  throw new Error(`[android-versions] ${message}`);
}

function lineValues(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

export function assertVersionCode(value, label = "versionCode") {
  if (typeof value !== "string" || !VERSION_CODE_PATTERN.test(value)) {
    fail(`${label} must be a positive decimal integer string`);
  }
  if (Number(value) > MAX_PLAY_VERSION_CODE) {
    fail(`${label} exceeds the Google Play bound ${MAX_PLAY_VERSION_CODE}`);
  }
  return value;
}

export function assertVersionName(value, label = "versionName") {
  if (typeof value !== "string" || !VERSION_NAME_PATTERN.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function readCommittedAndroidVersion(buildGradle) {
  if (typeof buildGradle !== "string" || buildGradle.length === 0) {
    fail("build.gradle is empty");
  }
  const codes = lineValues(buildGradle, /^\s*def\s+resolvedVersionCode\s*=\s*([1-9][0-9]*)\s*$/gmu);
  if (codes.length !== 1) fail("expected exactly one committed resolvedVersionCode");
  const names = lineValues(
    buildGradle,
    /^\s*def\s+resolvedVersionName\s*=\s*versionNameOverride\s*\?:\s*"([^"]+)"\s*$/gmu,
  );
  if (names.length !== 1) fail("expected exactly one committed resolvedVersionName");
  const applicationIds = lineValues(buildGradle, /^\s*applicationId\s+"([^"]*)"\s*$/gmu);
  const anyApplicationId = lineValues(buildGradle, /^\s*applicationId\b(.*)$/gmu);
  if (
    applicationIds.length !== 1 ||
    anyApplicationId.length !== 1 ||
    applicationIds[0] !== ANDROID_APPLICATION_ID
  ) {
    fail(`applicationId must be exactly "${ANDROID_APPLICATION_ID}" exactly once`);
  }
  const consumedCodes = lineValues(buildGradle, /^\s*versionCode\s+(\S+)\s*$/gmu);
  const consumedNames = lineValues(buildGradle, /^\s*versionName\s+(\S+)\s*$/gmu);
  if (
    consumedCodes.join("\0") !== "resolvedVersionCode" ||
    consumedNames.join("\0") !== "resolvedVersionName"
  ) {
    fail("defaultConfig must consume resolvedVersionCode and resolvedVersionName exactly once");
  }
  return {
    applicationId: ANDROID_APPLICATION_ID,
    versionName: assertVersionName(names[0], "committed versionName"),
    versionCode: assertVersionCode(codes[0], "committed versionCode"),
  };
}

export function readCommittedAndroidVersionFromRoot(root) {
  const file = path.join(root, ANDROID_BUILD_GRADLE);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    fail("build.gradle must be a bounded regular file");
  }
  return readCommittedAndroidVersion(fs.readFileSync(file, "utf8"));
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  try {
    if (process.argv.length !== 3) fail("usage: mobile-versions.mjs <source-root>");
    const version = readCommittedAndroidVersionFromRoot(process.argv[2]);
    process.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "[android-versions] failed"}\n`);
    process.exitCode = 1;
  }
}
