#!/usr/bin/env node
/**
 * Lightweight static checks for the Capacitor iOS project.
 *
 * These checks are intentionally text-based so they can run in CI before
 * opening Xcode and catch common config drift quickly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const paths = {
  capacitorConfig: path.join(repoRoot, "packages", "frontend", "capacitor.config.ts"),
  nativeAuth: path.join(repoRoot, "packages", "frontend", "src", "auth", "nativeAuth.ts"),
  infoPlist: path.join(repoRoot, "packages", "frontend", "ios", "App", "App", "Info.plist"),
  entitlementsDebug: path.join(
    repoRoot,
    "packages",
    "frontend",
    "ios",
    "App",
    "App",
    "App.debug.entitlements",
  ),
  entitlementsRelease: path.join(
    repoRoot,
    "packages",
    "frontend",
    "ios",
    "App",
    "App",
    "App.release.entitlements",
  ),
  pbxproj: path.join(
    repoRoot,
    "packages",
    "frontend",
    "ios",
    "App",
    "App.xcodeproj",
    "project.pbxproj",
  ),
};

const failures = [];

const capacitorConfig = read(paths.capacitorConfig);
expectContains(
  capacitorConfig,
  "StatusBar: {",
  `${relative(paths.capacitorConfig)} must configure the native status bar before the WebView renders`,
);
expectContains(
  capacitorConfig,
  'backgroundColor: "#ffffff"',
  `${relative(paths.capacitorConfig)} must use a light initial status-bar background`,
);
expectContains(
  capacitorConfig,
  "overlaysWebView: false",
  `${relative(paths.capacitorConfig)} must keep native content below the iOS status bar`,
);
expectContains(
  capacitorConfig,
  'style: "LIGHT"',
  `${relative(paths.capacitorConfig)} must use dark initial status-bar icons`,
);

const nativeAuth = read(paths.nativeAuth);
expectContains(
  nativeAuth,
  'export const NATIVE_AUTH_CALLBACK_URL = "instafy://auth";',
  `${relative(paths.nativeAuth)} must keep the native callback URL as instafy://auth`,
);
expectContains(
  nativeAuth,
  'export const NATIVE_AUTH_CALLBACK_SCHEME = "instafy";',
  `${relative(paths.nativeAuth)} must keep the native callback scheme as instafy`,
);
expectContains(
  nativeAuth,
  'export const NATIVE_AUTH_CALLBACK_HOST = "auth";',
  `${relative(paths.nativeAuth)} must keep the native callback host as auth`,
);

const infoPlist = read(paths.infoPlist);
expectContains(
  infoPlist,
  "<string>instafy</string>",
  `${relative(paths.infoPlist)} must include the instafy URL scheme`,
);
expectContains(
  infoPlist,
  "<string>arm64</string>",
  `${relative(paths.infoPlist)} should declare arm64 as required device capability`,
);

const debugEntitlements = read(paths.entitlementsDebug);
expectContains(
  debugEntitlements,
  "<string>development</string>",
  `${relative(paths.entitlementsDebug)} must use aps-environment=development`,
);

const releaseEntitlements = read(paths.entitlementsRelease);
expectContains(
  releaseEntitlements,
  "<string>production</string>",
  `${relative(paths.entitlementsRelease)} must use aps-environment=production`,
);

const pbxproj = read(paths.pbxproj);
const developmentTeamAssignments = [...pbxproj.matchAll(/DEVELOPMENT_TEAM = ([^;]+);/g)].map(
  (match) => match[1].trim(),
);

if (developmentTeamAssignments.length === 0) {
  failures.push(
    `${relative(paths.pbxproj)} must define DEVELOPMENT_TEAM assignments for iOS targets.`,
  );
} else {
  const hardcoded = developmentTeamAssignments.filter((value) => value !== "\"\"" && value !== "");
  if (hardcoded.length > 0) {
    failures.push(
      `${relative(paths.pbxproj)} has hardcoded DEVELOPMENT_TEAM values (${hardcoded.join(
        ", ",
      )}). Leave these empty and inject team id in CI/Xcode at release time.`,
    );
  }
}

if (failures.length > 0) {
  console.error("[check-ios-config] failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-ios-config] ok");

function read(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`Unable to read ${relative(filePath)}: ${message}`);
    return "";
  }
}

function expectContains(content, needle, failureMessage) {
  if (!content.includes(needle)) {
    failures.push(failureMessage);
  }
}

function relative(filePath) {
  return path.relative(repoRoot, filePath) || filePath;
}
