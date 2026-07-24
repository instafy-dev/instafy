#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message) {
  throw new Error(message);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value) {
    fail(`${name} must be a non-empty string.`);
  }
  return value;
}

function normalizePublishedAt(value) {
  const parsed = new Date(requireString(value, "publishedAt"));
  if (Number.isNaN(parsed.getTime())) fail("publishedAt must be a valid timestamp.");
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseSemver(value) {
  const match = SEMVER.exec(requireString(value, "version"));
  if (!match) fail(`Invalid SemVer version: ${JSON.stringify(value)}.`);
  return {
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart);
      const rightNumber = BigInt(rightPart);
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] > right[part] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function validateSourceSha(value) {
  const sourceSha = requireString(value, "sourceSha");
  if (!FULL_GIT_SHA.test(sourceSha)) fail("sourceSha must be a full lowercase Git commit SHA.");
  return sourceSha;
}

function validateTag(tag, version, channel) {
  const value = requireString(tag, "tag");
  if (channel === "stable" && value !== `desktop-app-v${version}`) {
    fail("A stable tag must exactly match desktop-app-v<version>.");
  }
  if (!/^desktop-app-v[A-Za-z0-9.+-]+$/.test(value)) {
    fail("tag contains unsupported characters.");
  }
  return value;
}

function validateArtifactName(value, name) {
  const artifact = requireString(value, name);
  if (!SAFE_ARTIFACT_NAME.test(artifact)) fail(`${name} must be one safe file name.`);
  return artifact;
}

export function createDesktopReleaseManifest(input) {
  const version = requireString(input.version, "version");
  parseSemver(version);
  // Build metadata is valid SemVer but creates ambiguous encoded filenames
  // (`+` versus `%2B`) across Electron, URLs, and R2 keys. Desktop releases use
  // plain or prerelease SemVer only.
  if (version.includes("+")) fail("Desktop release versions must not use SemVer build metadata.");
  const channel = input.channel;
  if (channel !== "stable" && channel !== "internal") {
    fail("channel must be stable or internal.");
  }
  const tag = validateTag(input.tag, version, channel);
  const sourceSha = validateSourceSha(input.sourceSha);
  const publishedAt = normalizePublishedAt(input.publishedAt);
  const feedUrl = new URL(requireString(input.feedUrl, "feedUrl"));
  if (
    feedUrl.protocol !== "https:" ||
    feedUrl.username ||
    feedUrl.password ||
    feedUrl.search ||
    feedUrl.hash
  ) {
    fail("feedUrl must be an absolute HTTPS URL without a query or fragment.");
  }
  const normalizedFeedUrl = feedUrl.href.replace(/\/$/, "");
  const macDmgName = validateArtifactName(input.macDmgName, "macDmgName");
  const macZipName = validateArtifactName(input.macZipName, "macZipName");
  const windowsExeName = validateArtifactName(input.windowsExeName, "windowsExeName");
  const macDmg = new RegExp(`^instafy-studio-${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-mac-(arm64|x64)\\.dmg$`).exec(macDmgName);
  const macArch = macDmg?.[1];
  if (!macArch || macZipName !== `instafy-studio-${version}-mac-${macArch}.zip`) {
    fail("macOS artifacts must name the release version and one consistent architecture.");
  }
  if (windowsExeName !== `instafy-studio-${version}-win.exe`) {
    fail("The Windows artifact must name the release version.");
  }
  const artifactUrl = (name) => `${normalizedFeedUrl}/${encodeURIComponent(name)}`;
  const artifacts = {
    macDmg: artifactUrl(macDmgName),
    macZip: artifactUrl(macZipName),
    windowsExe: artifactUrl(windowsExeName),
  };
  if (input.linuxAppImageName) {
    const linuxName = validateArtifactName(input.linuxAppImageName, "linuxAppImageName");
    if (channel === "stable") fail("Stable metadata must not include an unsigned Linux artifact.");
    if (linuxName !== `instafy-studio-${version}-linux.AppImage`) {
      fail("The Linux artifact must name the release version.");
    }
    artifacts.linuxAppImage = artifactUrl(linuxName);
  } else if (channel === "internal") {
    fail("Internal metadata requires the Linux engineering artifact.");
  }

  return {
    tag,
    version,
    channel,
    sourceSha,
    publishedAt,
    feedUrl: normalizedFeedUrl,
    architectures: { mac: [macArch] },
    artifacts,
  };
}

export function createStableReleasePointer(manifest) {
  if (manifest.channel !== "stable") fail("Only a stable manifest can create a stable pointer.");
  return {
    schemaVersion: 1,
    channel: "stable",
    tag: validateTag(manifest.tag, manifest.version, "stable"),
    version: parseSemver(manifest.version).raw,
    sourceSha: validateSourceSha(manifest.sourceSha),
    publishedAt: normalizePublishedAt(manifest.publishedAt),
  };
}

export function parseStableReleasePointer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Stable release pointer must be an object.");
  }
  const allowed = new Set([
    "schemaVersion",
    "channel",
    "tag",
    "version",
    "sourceSha",
    "publishedAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Stable release pointer contains unexpected field ${key}.`);
  }
  if (value.schemaVersion !== 1 || value.channel !== "stable") {
    fail("Stable release pointer has an unsupported schema or channel.");
  }
  const version = parseSemver(value.version).raw;
  if (version.includes("+")) fail("Stable pointer versions must not use SemVer build metadata.");
  const publishedAt = normalizePublishedAt(value.publishedAt);
  if (publishedAt !== value.publishedAt) {
    fail("Stable pointer publishedAt must be a canonical UTC second-precision timestamp.");
  }
  return {
    schemaVersion: 1,
    channel: "stable",
    tag: validateTag(value.tag, version, "stable"),
    version,
    sourceSha: validateSourceSha(value.sourceSha),
    publishedAt,
  };
}

export function assertStableReleaseTransition(currentValue, nextValue) {
  const current = parseStableReleasePointer(currentValue);
  const next = parseStableReleasePointer(nextValue);
  if (JSON.stringify(current) === JSON.stringify(next)) return next;
  if (compareSemver(next.version, current.version) <= 0) {
    fail(`Refusing to move stable from ${current.version} to non-newer ${next.version}.`);
  }
  return next;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function main() {
  const required = [
    "LATEST_PATH",
    "RELEASE_TAG",
    "RELEASE_VERSION",
    "RELEASE_CHANNEL",
    "RELEASE_SOURCE_SHA",
    "RELEASE_PUBLISHED_AT",
    "RELEASE_FEED_URL",
    "MAC_DMG_NAME",
    "MAC_ZIP_NAME",
    "WINDOWS_EXE_NAME",
  ];
  for (const name of required) {
    if (!process.env[name]) fail(`Missing release metadata environment value: ${name}.`);
  }
  const manifest = createDesktopReleaseManifest({
    tag: process.env.RELEASE_TAG,
    version: process.env.RELEASE_VERSION,
    channel: process.env.RELEASE_CHANNEL,
    sourceSha: process.env.RELEASE_SOURCE_SHA,
    publishedAt: process.env.RELEASE_PUBLISHED_AT,
    feedUrl: process.env.RELEASE_FEED_URL,
    macDmgName: process.env.MAC_DMG_NAME,
    macZipName: process.env.MAC_ZIP_NAME,
    windowsExeName: process.env.WINDOWS_EXE_NAME,
    linuxAppImageName: process.env.LINUX_APPIMAGE_NAME || undefined,
  });
  writeJson(process.env.LATEST_PATH, manifest);

  if (manifest.channel === "stable") {
    if (!process.env.POINTER_PATH) fail("POINTER_PATH is required for a stable release.");
    const pointer = createStableReleasePointer(manifest);
    if (process.env.CURRENT_POINTER_PATH) {
      const current = JSON.parse(fs.readFileSync(process.env.CURRENT_POINTER_PATH, "utf8"));
      assertStableReleaseTransition(current, pointer);
    }
    writeJson(process.env.POINTER_PATH, pointer);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[desktop-release-metadata] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
