#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE_PACKAGE_MARKERS = Object.freeze([
  ["operator", "console"].join("-"),
  ["org", "credits"].join("-"),
  ["infra", "pulumi"].join("-"),
  ["kno", "sh", "contract"].join("-"),
]);
const PRODUCT_MARKER = ["kno", "sh"].join("");
const PRODUCT_MARKER_EXCEPTION = ["packages", "provider-contract"].join("/");
const AUTH_FILE_SUFFIX = [".codex", "auth.json"].join("/");
const INTERNAL_DIRECTORY = ["inter", "nal"].join("");

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
    regex: /\bVITE_[A-Z0-9_]*SERVICE_ROLE(?:_[A-Z0-9_]+)?\b/i,
  },
]);

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/").replace(/^\.\/+/, "");
}

function isLiveEnvironmentPath(filePath) {
  const basename = path.posix.basename(filePath);
  if (basename === ".env") {
    return true;
  }
  return basename.startsWith(".env.") && !basename.endsWith(".example");
}

function pathFindings(filePath) {
  const normalized = normalizePath(filePath);
  const lowerPath = normalized.toLowerCase();
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
  if (isLiveEnvironmentPath(lowerPath)) {
    findings.push("live-environment-file");
  }
  for (const marker of PRIVATE_PACKAGE_MARKERS) {
    if (lowerPath.includes(marker)) {
      findings.push("private-package");
      break;
    }
  }
  if (
    lowerPath.includes(PRODUCT_MARKER) &&
    !lowerPath.startsWith(`${PRODUCT_MARKER_EXCEPTION}/`)
  ) {
    findings.push("private-product");
  }

  return findings;
}

function contentFindings(filePath, content) {
  const normalized = normalizePath(filePath);
  const lowerPath = normalized.toLowerCase();
  const text = content.toString("utf8");
  const lowerText = text.toLowerCase();
  const findings = [];

  for (const marker of CONTENT_MARKERS) {
    const matched = marker.regex
      ? marker.regex.test(text)
      : (marker.caseInsensitive ? lowerText : text).includes(
          marker.caseInsensitive ? marker.needle.toLowerCase() : marker.needle,
        );
    if (matched) {
      findings.push(marker.id);
    }
  }

  if (
    !lowerPath.startsWith(`${PRODUCT_MARKER_EXCEPTION}/`) &&
    lowerText.includes(PRODUCT_MARKER)
  ) {
    findings.push("private-product");
  }

  return findings;
}

export function findPublicBoundaryViolations({ root, paths }) {
  const violations = [];
  for (const candidatePath of [...new Set(paths.map(normalizePath))].sort()) {
    for (const rule of pathFindings(candidatePath)) {
      violations.push({ path: candidatePath, rule });
    }

    const absolutePath = path.join(root, candidatePath);
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
    if (!stat.isFile()) {
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
  }
  return violations;
}

function listRepositoryFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return output.split("\0").filter(Boolean);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = listRepositoryFiles(root);
  const violations = findPublicBoundaryViolations({ root, paths });
  if (violations.length > 0) {
    console.error("Public boundary gate: FAIL");
    for (const violation of violations) {
      console.error(`${violation.rule}\t${violation.path}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Public boundary gate: PASS (${paths.length} repository paths scanned)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
