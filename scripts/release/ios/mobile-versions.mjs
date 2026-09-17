#!/usr/bin/env node
// Committed iOS version tuple of a public core checkout. The pbxproj is the only
// source of truth: every MARKETING_VERSION / CURRENT_PROJECT_VERSION occurrence
// must agree and every bundle identifier must stay within the app's identity.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const IOS_PROJECT_FILE = "packages/frontend/ios/App/App.xcodeproj/project.pbxproj";
export const APPLICATION_ID = "dev.instafy.studio";
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(`[ios-versions] ${message}`);
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

export function parseIosVersions(projectText) {
  if (typeof projectText !== "string" || projectText.includes("�")) {
    fail("iOS project configuration is not valid UTF-8 text");
  }
  const name = oneConsistentValue(
    lineValues(projectText, /^\s*MARKETING_VERSION\s*=\s*([^;\s]+)\s*;\s*$/gmu),
    "iOS MARKETING_VERSION",
  );
  const code = oneConsistentValue(
    lineValues(projectText, /^\s*CURRENT_PROJECT_VERSION\s*=\s*([^;\s]+)\s*;\s*$/gmu),
    "iOS CURRENT_PROJECT_VERSION",
  );
  if (!/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(name)) {
    fail("iOS MARKETING_VERSION must be a dotted numeric version");
  }
  if (!/^[1-9][0-9]*$/u.test(code) || Number(code) > 2_100_000_000) {
    fail("iOS CURRENT_PROJECT_VERSION must be a positive integer");
  }
  const bundleIds = lineValues(
    projectText,
    /^\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s]+)\s*;\s*$/gmu,
  );
  if (
    !bundleIds.includes(APPLICATION_ID) ||
    bundleIds.some((value) => value !== APPLICATION_ID && value !== `${APPLICATION_ID}.uitests`)
  ) {
    fail(`iOS application identity must remain ${APPLICATION_ID}`);
  }
  return { name, code };
}

export function readIosVersions(root) {
  const filePath = path.join(root, IOS_PROJECT_FILE);
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    fail("iOS project configuration is missing");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROJECT_BYTES) {
    fail("iOS project configuration must be a bounded regular file");
  }
  const buffer = fs.readFileSync(filePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("iOS project configuration is not valid UTF-8 text");
  }
  return parseIosVersions(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 3) fail("usage: mobile-versions.mjs <public-core-root>");
    process.stdout.write(`${JSON.stringify(readIosVersions(process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && error.message.startsWith("[ios-versions]") ? error.message : "[ios-versions] failed"}\n`,
    );
    process.exitCode = 1;
  }
}
