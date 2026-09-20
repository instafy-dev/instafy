#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PRIVATE_PACKAGE_MARKERS = Object.freeze([
  ["operator", "console"].join("-"),
  ["org", "credits"].join("-"),
  ["infra", "pulumi"].join("-"),
  [["kno", "sh"].join(""), "contract"].join("-"),
]);
const PRODUCT_MARKER = ["kno", "sh"].join("");
const PRODUCT_MARKER_EXCEPTIONS = Object.freeze([
  ["packages", "provider-contract"].join("/"),
  // The vendored hosted-web robot integration slice keeps the product's wire
  // identifiers verbatim. Only this exact directory prefix is exempt; the
  // private package marker and every other rule still apply inside it.
  ["packages", "frontend", "hosted", "robot"].join("/"),
]);
const AUTH_FILE_SUFFIX = [".codex", "auth.json"].join("/");
const INTERNAL_DIRECTORY = ["inter", "nal"].join("");

function isProductMarkerException(normalizedPath) {
  return PRODUCT_MARKER_EXCEPTIONS.some((prefix) =>
    normalizedPath.startsWith(`${prefix}/`),
  );
}

const CONTENT_MARKERS = Object.freeze([
  {
    id: "absolute-personal-path",
    needle: `/${["Users", ""].join("/")}`,
    caseInsensitive: false,
  },
  {
    id: "private-network",
    needle: `${[10, 42].join(".")}.`,
    caseInsensitive: false,
  },
  {
    id: "private-host",
    needle: ["internal", "instafy", "dev"].join("."),
    caseInsensitive: true,
  },
  ...[
    ["gh", "p_"].join(""),
    ["gh", "o_"].join(""),
    ["github", "_pat_"].join(""),
  ].map((needle) => ({
    id: "github-token-prefix",
    needle,
    caseInsensitive: false,
  })),
  ...PRIVATE_PACKAGE_MARKERS.map((needle) => ({
    id: "private-package",
    needle,
    caseInsensitive: true,
  })),
  {
    id: "browser-exposed-service-role",
    regex: /\bVITE_[A-Z0-9_]*SERVICE_ROLE(?:_[A-Z0-9_]+)?\b/iu,
  },
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".dmg",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".gzip",
  ".ico",
  ".icns",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
  ".zst",
]);
const BINARY_MAGIC_PREFIXES = [
  Buffer.from("377abcaf271c", "hex"),
  Buffer.from("425a68", "hex"),
  Buffer.from("474946383761", "hex"),
  Buffer.from("474946383961", "hex"),
  Buffer.from("4d5a", "hex"),
  Buffer.from("504b0304", "hex"),
  Buffer.from("504b0506", "hex"),
  Buffer.from("504b0708", "hex"),
  Buffer.from("526172211a0700", "hex"),
  Buffer.from("526172211a070100", "hex"),
  Buffer.from("7f454c46", "hex"),
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("cafebabe", "hex"),
  Buffer.from("cefaedfe", "hex"),
  Buffer.from("feedface", "hex"),
  Buffer.from("feedfacf", "hex"),
  Buffer.from("ffd8ff", "hex"),
  Buffer.from("fd377a585a00", "hex"),
  Buffer.from("28b52ffd", "hex"),
  Buffer.from("1f8b", "hex"),
  Buffer.from("%PDF-", "ascii"),
  Buffer.from("OTTO", "ascii"),
  Buffer.from("wOFF", "ascii"),
  Buffer.from("wOF2", "ascii"),
];
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_MARKER_BYTES = 16 * 1024 * 1024;
const GIT_LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";
const CANONICAL_GITMODULES = Buffer.from(
  [
    '[submodule "codex"]',
    "\tpath = codex",
    "\turl = https://github.com/instafy-dev/codex",
    "\tbranch = instafy/integration",
    "",
  ].join("\n"),
  "utf8",
);
const REGULAR_INDEX_MODES = new Set(["100644", "100755"]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export const PUBLIC_BOUNDARY_POLICY_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "public-boundary-policy.json",
);

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/").replace(/^\.\/+/u, "");
}

function isSafeRepositoryPath(filePath) {
  return (
    filePath.length > 0 &&
    !path.posix.isAbsolute(filePath) &&
    !filePath.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(filePath) &&
    filePath.normalize("NFC") === filePath &&
    !filePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..") &&
    path.posix.normalize(filePath) === filePath
  );
}

function isEnvironmentPath(filePath) {
  const basename = path.posix.basename(filePath);
  return basename === ".env" || basename.startsWith(".env.");
}

function pathFindings(filePath, approvedEnvironmentTemplates = new Set()) {
  const normalizedPath = normalizePath(filePath);
  const lowerPath = normalizedPath.toLocaleLowerCase("en-US");
  const segments = lowerPath.split("/");
  const findings = [];

  if (segments.includes(INTERNAL_DIRECTORY)) {
    findings.push("private-directory");
  }
  if (
    lowerPath === AUTH_FILE_SUFFIX ||
    lowerPath.endsWith(`/${AUTH_FILE_SUFFIX}`)
  ) {
    findings.push("live-auth-file");
  }
  if (
    path.posix.basename(lowerPath) === ".envrc" ||
    (isEnvironmentPath(lowerPath) &&
      !approvedEnvironmentTemplates.has(normalizedPath))
  ) {
    findings.push("live-environment-file");
  }
  if (PRIVATE_PACKAGE_MARKERS.some((marker) => lowerPath.includes(marker))) {
    findings.push("private-package");
  }
  if (
    lowerPath.includes(PRODUCT_MARKER) &&
    !isProductMarkerException(normalizedPath)
  ) {
    findings.push("private-product");
  }
  for (const rule of contentFindings(
    normalizedPath,
    Buffer.from(normalizedPath, "utf8"),
  )) {
    findings.push(rule);
  }
  return [...new Set(findings)];
}

function foldedAscii(byte) {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function containsEncodedAscii(buffer, needle, width, littleEndian, insensitive) {
  const expected = Buffer.from(needle, "ascii");
  const byteLength = expected.length * width;
  if (byteLength > buffer.length) {
    return false;
  }

  for (let start = 0; start <= buffer.length - byteLength; start += 1) {
    let matches = true;
    for (let index = 0; index < expected.length; index += 1) {
      const unitStart = start + index * width;
      const characterOffset = littleEndian ? 0 : width - 1;
      const actual = buffer[unitStart + characterOffset];
      const wanted = expected[index];
      if (
        (insensitive ? foldedAscii(actual) : actual) !==
        (insensitive ? foldedAscii(wanted) : wanted)
      ) {
        matches = false;
        break;
      }
      for (let byteIndex = 0; byteIndex < width; byteIndex += 1) {
        if (
          byteIndex !== characterOffset &&
          buffer[unitStart + byteIndex] !== 0
        ) {
          matches = false;
          break;
        }
      }
      if (!matches) {
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function containsWideAscii(buffer, needle, insensitive) {
  return (
    containsEncodedAscii(buffer, needle, 2, true, insensitive) ||
    containsEncodedAscii(buffer, needle, 2, false, insensitive) ||
    containsEncodedAscii(buffer, needle, 4, true, insensitive) ||
    containsEncodedAscii(buffer, needle, 4, false, insensitive)
  );
}

function strictUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function bufferContainsProductMarker(buffer) {
  const text = strictUtf8(buffer);
  return (
    text?.toLocaleLowerCase("en-US").includes(PRODUCT_MARKER) ||
    (text === null &&
      containsEncodedAscii(buffer, PRODUCT_MARKER, 1, true, true)) ||
    (buffer.includes(0) && containsWideAscii(buffer, PRODUCT_MARKER, true))
  );
}

function decodeCanonicalBase64(value) {
  const unpadded = value
    .replace(/=+$/u, "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  if (unpadded.length % 4 === 1) {
    return null;
  }
  const padded = unpadded.padEnd(
    unpadded.length + ((4 - (unpadded.length % 4)) % 4),
    "=",
  );
  const decoded = Buffer.from(padded, "base64");
  return decoded.toString("base64").replace(/=+$/u, "") === unpadded
    ? decoded
    : null;
}

function encodedProductFinding(content) {
  const rootText = strictUtf8(content);
  if (rootText === null) {
    return null;
  }

  const queue = [{ depth: 0, text: rootText }];
  let decodedBytes = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { depth, text } = queue[cursor];
    if (depth >= 3) {
      continue;
    }
    const candidates = [];
    if (text.includes("%")) {
      const percentDecoded = text.replace(
        /(?:%[0-9a-f]{2})+/giu,
        (encoded) =>
          Buffer.from(encoded.replaceAll("%", ""), "hex").toString("utf8"),
      );
      if (percentDecoded !== text) {
        candidates.push(Buffer.from(percentDecoded, "utf8"));
      }
    }
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{6,}={0,2}(?![A-Za-z0-9+/_=-])/gu,
    )) {
      const decoded = decodeCanonicalBase64(match[0]);
      if (decoded) {
        candidates.push(decoded);
      }
    }
    for (const match of text.matchAll(
      /(?<![0-9a-f])(?:[0-9a-f]{2}){5,}(?![0-9a-f])/giu,
    )) {
      candidates.push(Buffer.from(match[0], "hex"));
    }

    for (const candidate of candidates) {
      decodedBytes += candidate.length;
      if (decodedBytes > MAX_DECODED_MARKER_BYTES) {
        return "encoded-content-budget-exceeded";
      }
      if (bufferContainsProductMarker(candidate)) {
        return "private-product";
      }
      const decodedText = strictUtf8(candidate);
      if (decodedText !== null) {
        queue.push({ depth: depth + 1, text: decodedText });
      }
    }
  }
  return null;
}

function asciiLane(buffer, width, littleEndian, phase) {
  let result = "";
  const characterOffset = littleEndian ? 0 : width - 1;
  for (let start = phase; start + width <= buffer.length; start += width) {
    let ascii = true;
    for (let byteIndex = 0; byteIndex < width; byteIndex += 1) {
      if (
        byteIndex !== characterOffset &&
        buffer[start + byteIndex] !== 0
      ) {
        ascii = false;
        break;
      }
    }
    const character = buffer[start + characterOffset];
    result +=
      ascii && character <= 0x7f ? String.fromCharCode(character) : "\ufffd";
  }
  return result;
}

function decodedTextViews(buffer) {
  const views = [];
  try {
    views.push(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    // Invalid UTF-8 is binary and must match the exact binary policy.
  }
  if (buffer.includes(0)) {
    for (const width of [2, 4]) {
      for (const littleEndian of [true, false]) {
        for (let phase = 0; phase < width; phase += 1) {
          views.push(asciiLane(buffer, width, littleEndian, phase));
        }
      }
    }
  }
  return views;
}

function contentFindings(filePath, content) {
  const normalizedPath = normalizePath(filePath);
  const lowerPath = normalizedPath.toLocaleLowerCase("en-US");
  const findings = [];
  let textViews;
  const strictText = strictUtf8(content);
  const lowerStrictText = strictText?.toLocaleLowerCase("en-US");
  const mayContainWideText = content.includes(0);

  if (strictText?.startsWith(GIT_LFS_POINTER_HEADER)) {
    findings.push("git-lfs-pointer");
  }
  if (
    path.posix.basename(lowerPath) === ".gitattributes" &&
    /\b(?:filter|diff|merge)\s*=\s*lfs\b/iu.test(strictText ?? "")
  ) {
    findings.push("git-lfs-attribute");
  }

  for (const marker of CONTENT_MARKERS) {
    const matched = marker.regex
      ? (textViews ??= decodedTextViews(content)).some((text) =>
          marker.regex.test(text),
        )
      : (marker.caseInsensitive ? lowerStrictText : strictText)?.includes(
          marker.caseInsensitive
            ? marker.needle.toLocaleLowerCase("en-US")
            : marker.needle,
        ) ||
        (strictText === null &&
          containsEncodedAscii(
            content,
            marker.needle,
            1,
            true,
            marker.caseInsensitive,
          )) ||
        (mayContainWideText &&
          containsWideAscii(content, marker.needle, marker.caseInsensitive));
    if (matched) {
      findings.push(marker.id);
    }
  }
  if (!isProductMarkerException(normalizedPath)) {
    if (bufferContainsProductMarker(content)) {
      findings.push("private-product");
    } else {
      const encodedFinding = encodedProductFinding(content);
      if (encodedFinding) {
        findings.push(encodedFinding);
      }
    }
  }
  return findings;
}

function bufferStartsWith(buffer, prefix) {
  return (
    buffer.length >= prefix.length &&
    buffer.subarray(0, prefix.length).equals(prefix)
  );
}

function isBinary(filePath, buffer) {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (
    BINARY_EXTENSIONS.has(extension) ||
    buffer.includes(0) ||
    BINARY_MAGIC_PREFIXES.some((prefix) => bufferStartsWith(buffer, prefix)) ||
    (buffer.length >= 262 &&
      buffer.subarray(257, 262).toString("ascii") === "ustar")
  ) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function normalizeBinaryPolicy(policy) {
  const source =
    policy instanceof Map ? policy : (policy?.binarySha256 ?? new Map());
  const entries =
    source instanceof Map ? [...source.entries()] : Object.entries(source);
  const binarySha256 = new Map();
  for (const [filePath, digest] of entries) {
    const normalized = normalizePath(filePath);
    if (
      !isSafeRepositoryPath(normalized) ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(digest)
    ) {
      throw new Error("invalid public boundary binary policy");
    }
    binarySha256.set(normalized, digest);
  }
  return binarySha256;
}

function normalizeApprovedEnvironmentTemplates(policy) {
  const source = policy?.approvedEnvironmentTemplates ?? [];
  const entries = source instanceof Set ? [...source] : source;
  if (!Array.isArray(entries)) {
    throw new Error("invalid public boundary environment policy");
  }
  const approvedEnvironmentTemplates = new Set();
  for (const filePath of entries) {
    const normalized =
      typeof filePath === "string" ? normalizePath(filePath) : "";
    if (
      !isSafeRepositoryPath(normalized) ||
      !isEnvironmentPath(normalized.toLocaleLowerCase("en-US")) ||
      !path.posix
        .basename(normalized)
        .toLocaleLowerCase("en-US")
        .endsWith(".example")
    ) {
      throw new Error("invalid public boundary environment policy");
    }
    approvedEnvironmentTemplates.add(normalized);
  }
  if (approvedEnvironmentTemplates.size !== entries.length) {
    throw new Error("duplicate public boundary environment policy");
  }
  return approvedEnvironmentTemplates;
}

function normalizeApprovedGitlinks(policy) {
  const source = policy?.approvedGitlinks ?? {};
  const entries =
    source instanceof Map ? [...source.entries()] : Object.entries(source);
  const approvedGitlinks = new Map();
  for (const [filePath, object] of entries) {
    const normalized =
      typeof filePath === "string" ? normalizePath(filePath) : "";
    if (
      !isSafeRepositoryPath(normalized) ||
      typeof object !== "string" ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(object)
    ) {
      throw new Error("invalid public boundary gitlink policy");
    }
    approvedGitlinks.set(normalized, object);
  }
  return approvedGitlinks;
}

export function loadPublicBoundaryPolicy(policyPath = PUBLIC_BOUNDARY_POLICY_PATH) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(policyPath),
  );
  const parsed = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "approvedEnvironmentTemplates,approvedGitlinks,binaryAssetCount,binarySha256,schemaVersion" ||
    parsed.schemaVersion !== 2 ||
    !Number.isSafeInteger(parsed.binaryAssetCount) ||
    parsed.binaryAssetCount < 0 ||
    !parsed.binarySha256 ||
    typeof parsed.binarySha256 !== "object" ||
    Array.isArray(parsed.binarySha256)
  ) {
    throw new Error("invalid public boundary policy schema");
  }
  const approvedEnvironmentTemplates =
    normalizeApprovedEnvironmentTemplates(parsed);
  const approvedGitlinks = normalizeApprovedGitlinks(parsed);
  const binarySha256 = normalizeBinaryPolicy({
    binarySha256: parsed.binarySha256,
  });
  const paths = [...binarySha256.keys()];
  const environmentPaths = [...approvedEnvironmentTemplates];
  const gitlinkPaths = [...approvedGitlinks.keys()];
  if (
    binarySha256.size !== parsed.binaryAssetCount ||
    paths.join("\n") !== [...paths].sort().join("\n") ||
    environmentPaths.join("\n") !== [...environmentPaths].sort().join("\n") ||
    gitlinkPaths.join("\n") !== [...gitlinkPaths].sort().join("\n")
  ) {
    throw new Error("invalid public boundary policy inventory");
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    binaryAssetCount: parsed.binaryAssetCount,
    approvedEnvironmentTemplates,
    approvedGitlinks,
    binarySha256,
  });
}

export function findPublicBoundaryViolations({
  root,
  paths,
  policy = { binarySha256: new Map() },
  requireCompletePolicy = false,
  indexEntries = [],
  requireRepositoryMetadata = false,
}) {
  const violations = [];
  const binarySha256 = normalizeBinaryPolicy(policy);
  const approvedEnvironmentTemplates =
    normalizeApprovedEnvironmentTemplates(policy);
  const approvedGitlinks = normalizeApprovedGitlinks(policy);
  const seenApprovedBinaries = new Set();
  const normalizedPaths = [];
  const indexEntryByPath = new Map();
  const gitlinkPaths = new Set();

  for (const entry of indexEntries) {
    const candidatePath = normalizePath(entry.path);
    if (
      !isSafeRepositoryPath(candidatePath) ||
      !/^[0-7]{6}$/u.test(entry.mode) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(entry.object) ||
      !/^[0-3]$/u.test(entry.stage)
    ) {
      violations.push({
        path: isSafeRepositoryPath(candidatePath)
          ? candidatePath
          : `<unsafe-index-path sha256=${sha256Buffer(Buffer.from(entry.path))}>`,
        rule: "invalid-git-index-entry",
      });
      continue;
    }
    if (entry.stage !== "0") {
      violations.push({ path: candidatePath, rule: "unmerged-git-index-entry" });
    }
    if (indexEntryByPath.has(candidatePath)) {
      violations.push({
        path: candidatePath,
        rule: "duplicate-git-index-entry",
      });
      continue;
    }
    indexEntryByPath.set(candidatePath, entry);
    if (entry.mode === "160000") {
      gitlinkPaths.add(candidatePath);
      const approvedObject = approvedGitlinks.get(candidatePath);
      if (!approvedObject) {
        violations.push({ path: candidatePath, rule: "unexpected-gitlink" });
      } else if (entry.object !== approvedObject) {
        violations.push({
          path: candidatePath,
          rule: "gitlink-object-mismatch",
        });
      }
    } else if (entry.mode === "120000") {
      violations.push({ path: candidatePath, rule: "symbolic-link" });
    } else if (!REGULAR_INDEX_MODES.has(entry.mode)) {
      violations.push({
        path: candidatePath,
        rule: "unsupported-git-index-mode",
      });
    }
  }

  if (requireRepositoryMetadata) {
    for (const approvedPath of approvedGitlinks.keys()) {
      if (indexEntryByPath.get(approvedPath)?.mode !== "160000") {
        violations.push({
          path: approvedPath,
          rule: "missing-approved-gitlink",
        });
      }
    }
    const gitmodulesEntry = indexEntryByPath.get(".gitmodules");
    if (gitmodulesEntry?.mode !== "100644") {
      violations.push({
        path: ".gitmodules",
        rule: "gitmodules-index-mode",
      });
    } else {
      const gitmodulesPath = path.join(root, ".gitmodules");
      try {
        const stat = lstatSync(gitmodulesPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          violations.push({
            path: ".gitmodules",
            rule: "unreadable-gitmodules",
          });
        } else if (!readFileSync(gitmodulesPath).equals(CANONICAL_GITMODULES)) {
          violations.push({
            path: ".gitmodules",
            rule: "gitmodules-content-mismatch",
          });
        }
      } catch {
        violations.push({
          path: ".gitmodules",
          rule: "unreadable-gitmodules",
        });
      }
    }
  }

  for (const rawPath of paths) {
    const candidatePath = normalizePath(rawPath);
    if (!isSafeRepositoryPath(candidatePath)) {
      violations.push({
        path: `<unsafe-path sha256=${sha256Buffer(Buffer.from(rawPath))}>`,
        rule: "unsafe-repository-path",
      });
    } else {
      normalizedPaths.push(candidatePath);
    }
  }

  for (const candidatePath of [...new Set(normalizedPaths)].sort()) {
    for (const rule of pathFindings(
      candidatePath,
      approvedEnvironmentTemplates,
    )) {
      violations.push({ path: candidatePath, rule });
    }

    if (gitlinkPaths.has(candidatePath)) {
      continue;
    }

    const absolutePath = path.join(root, ...candidatePath.split("/"));
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      violations.push({ path: candidatePath, rule: "unreadable-path" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      violations.push({ path: candidatePath, rule: "symbolic-link" });
      continue;
    }
    if (stat.isDirectory()) {
      continue;
    }
    if (!stat.isFile()) {
      violations.push({ path: candidatePath, rule: "special-file" });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      violations.push({ path: candidatePath, rule: "oversized-file" });
      continue;
    }

    let content;
    try {
      content = readFileSync(absolutePath);
    } catch {
      violations.push({ path: candidatePath, rule: "unreadable-file" });
      continue;
    }
    for (const rule of contentFindings(candidatePath, content)) {
      violations.push({ path: candidatePath, rule });
    }

    if (isBinary(candidatePath, content)) {
      const expectedDigest = binarySha256.get(candidatePath);
      if (!expectedDigest) {
        violations.push({ path: candidatePath, rule: "unapproved-binary" });
      } else if (sha256Buffer(content) !== expectedDigest) {
        violations.push({ path: candidatePath, rule: "binary-digest-mismatch" });
      } else {
        seenApprovedBinaries.add(candidatePath);
      }
    } else if (binarySha256.has(candidatePath)) {
      violations.push({
        path: candidatePath,
        rule: "approved-path-is-not-binary",
      });
    }
  }

  if (requireCompletePolicy) {
    for (const approvedPath of binarySha256.keys()) {
      if (!seenApprovedBinaries.has(approvedPath)) {
        violations.push({ path: approvedPath, rule: "missing-approved-binary" });
      }
    }
  }
  return violations;
}

function splitNullTerminatedPaths(buffer) {
  const paths = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (let offset = 0; offset < buffer.length; offset += 1) {
    if (buffer[offset] !== 0) {
      continue;
    }
    if (offset > start) {
      paths.push(decoder.decode(buffer.subarray(start, offset)));
    }
    start = offset + 1;
  }
  if (start !== buffer.length) {
    throw new Error("git path inventory was not NUL-terminated");
  }
  return paths;
}

function runGitPathInventory(root, args) {
  const output = execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      "ls-files",
      ...args,
      "-z",
    ],
    {
      encoding: "buffer",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return splitNullTerminatedPaths(output);
}

function parseGitIndexEntry(record) {
  const separator = record.indexOf("\t");
  if (separator === -1) {
    throw new Error("invalid git index inventory record");
  }
  const header = record.slice(0, separator);
  const match = /^([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])$/u.exec(
    header,
  );
  if (!match) {
    throw new Error("invalid git index inventory header");
  }
  return {
    mode: match[1],
    object: match[2],
    stage: match[3],
    path: record.slice(separator + 1),
  };
}

function listRepositoryInventory(root) {
  const indexEntries = runGitPathInventory(root, ["--stage"]).map(
    parseGitIndexEntry,
  );
  return {
    indexEntries,
    paths: [
      ...indexEntries.map(({ path: filePath }) => filePath),
      ...runGitPathInventory(root, ["--others", "--exclude-standard"]),
    ],
  };
}

function parseArguments(argv) {
  let root = REPOSITORY_ROOT;
  let policyPath = PUBLIC_BOUNDARY_POLICY_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--root" && argument !== "--policy") {
      throw new Error(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    if (argument === "--root") {
      root = path.resolve(value);
    } else {
      policyPath = path.resolve(value);
    }
    index += 1;
  }
  return { root, policyPath };
}

function safeDisplayPath(filePath) {
  if (
    !isSafeRepositoryPath(filePath) ||
    contentFindings(filePath, Buffer.from(filePath)).length > 0
  ) {
    return `<redacted-path sha256=${sha256Buffer(Buffer.from(filePath))}>`;
  }
  return filePath;
}

function main() {
  try {
    const { root, policyPath } = parseArguments(process.argv.slice(2));
    const policy = loadPublicBoundaryPolicy(policyPath);
    const { indexEntries, paths } = listRepositoryInventory(root);
    const violations = findPublicBoundaryViolations({
      root,
      paths,
      policy,
      requireCompletePolicy: true,
      indexEntries,
      requireRepositoryMetadata: true,
    });
    if (violations.length > 0) {
      console.error("Public boundary gate: FAIL");
      for (const violation of violations) {
        console.error(`${violation.rule}\t${safeDisplayPath(violation.path)}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `Public boundary gate: PASS (${paths.length} repository paths, ${policy.binaryAssetCount} exact binary digests)`,
    );
  } catch {
    console.error("Public boundary gate: FAIL");
    console.error("boundary-gate-error\t(scanner)");
    process.exitCode = 1;
  }
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)) {
      main();
    }
  } catch {
    // An imported module does not own process startup.
  }
}
