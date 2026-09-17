#!/usr/bin/env node
// Desktop lane copy of the release-artifact Gitleaks gate. The base config is
// scripts/public-boundary-gitleaks.toml; see releaseArtifactScannerConfig.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  realpathSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_VERSION = "8.30.1";
const MAX_BUFFER = 16 * 1024 * 1024;
const SAFE_ENV_NAMES = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

const RELEASE_ARTIFACT_ALLOWLIST = String.raw`
[[allowlists]]
description = "Supabase publishable keys are intentionally browser-visible"
targetRules = ["generic-api-key"]
regexes = ['''^sb_publishable_[A-Za-z0-9_-]{20,}$''']

[[allowlists]]
description = "Xcode symbol maps may contain hosted macOS build roots"
condition = "AND"
regexTarget = "line"
targetRules = ["instafy-absolute-personal-path"]
paths = ['''^instafy-release\.ipa\.zip!Symbols/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\.symbols$''']
regexes = ['''/U[s]ers/runner/''']
`;

function scannerEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && SAFE_ENV_NAMES.has(name),
    ),
  );
}

function requirePlainPath(candidate, kind) {
  const resolved = path.resolve(candidate);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`${kind} must not be a symbolic link`);
  }
  if (
    (kind === "release root" && !stat.isDirectory()) ||
    (kind === "Gitleaks config" && !stat.isFile())
  ) {
    throw new Error(`${kind} has the wrong file type`);
  }
  return resolved;
}

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    env: scannerEnvironment(),
    maxBuffer: MAX_BUFFER,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
    ...options,
  });
}

// The frozen public-boundary config flags the bare GitHub token prefix. In a
// large compressed artifact (DMG, ZIP, decoded blobs) four bytes of noise match
// that prefix by chance, at a different offset in every build, which would throw
// away a correctly signed and notarized build. Release artifacts are scanned for
// the token shape instead, exactly as the internal release gate does: every
// real token still matches, and the ghu_/ghs_/ghr_ families are covered too.
const GITHUB_TOKEN_RULE_ID = "instafy-github-token-prefix";
const GITHUB_TOKEN_SHAPE_REGEX =
  "(?:gh[pousr]_[A-Za-z0-9]{36,}|github_[p]at_[A-Za-z0-9_]{60,})";
const GITHUB_TOKEN_SHAPE_RULE = [
  "[[rules]]",
  `id = "${GITHUB_TOKEN_RULE_ID}"`,
  'description = "GitHub token (release artifact shape)"',
  `regex = '''${GITHUB_TOKEN_SHAPE_REGEX}'''`,
  "",
].join("\n");
const REGEX_LINE = /^regex = '''.*'''$/gmu;

function withGithubTokenShapeRule(baseConfig) {
  const blocks = baseConfig.split(/(?=^\[\[)/mu);
  const idLine = new RegExp(`^id = "${GITHUB_TOKEN_RULE_ID}"$`, "mu");
  const matches = blocks.filter((block) => idLine.test(block));
  if (matches.length > 1) {
    throw new Error("The base Gitleaks config defines the GitHub token rule more than once");
  }
  if (matches.length === 0) {
    const separator = baseConfig.endsWith("\n") ? "\n" : "\n\n";
    return `${baseConfig}${separator}${GITHUB_TOKEN_SHAPE_RULE}`;
  }
  const [block] = matches;
  if (!block.startsWith("[[rules]]") || (block.match(REGEX_LINE) ?? []).length !== 1) {
    throw new Error("The base Gitleaks GitHub token rule has an unexpected shape");
  }
  const replaced = block.replace(
    new RegExp(REGEX_LINE.source, "mu"),
    () => `regex = '''${GITHUB_TOKEN_SHAPE_REGEX}'''`,
  );
  return blocks.map((candidate) => (candidate === block ? replaced : candidate)).join("");
}

function releaseArtifactScannerConfig(baseConfig) {
  if (typeof baseConfig !== "string" || baseConfig.trim().length === 0) {
    throw new Error("The base Gitleaks config must not be empty");
  }
  const config = withGithubTokenShapeRule(baseConfig);
  const separator = config.endsWith("\n") ? "\n" : "\n\n";
  return `${config}${separator}${RELEASE_ARTIFACT_ALLOWLIST.trimStart()}`;
}

function runReleaseArtifactGate({
  root,
  config,
  executable,
  expectedVersion = REQUIRED_VERSION,
}) {
  const releaseRoot = requirePlainPath(root, "release root");
  const configPath = requirePlainPath(config, "Gitleaks config");
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("A pinned Gitleaks executable is required");
  }

  const version = run(executable, ["version"]);
  if (version.error || version.status !== 0) {
    throw new Error("The pinned Gitleaks scanner could not run");
  }
  if (version.stdout.trim() !== expectedVersion) {
    throw new Error("The Gitleaks scanner version does not match the release pin");
  }

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "instafy-release-gitleaks-"),
  );
  chmodSync(temporaryRoot, 0o700);
  const ignorePath = path.join(temporaryRoot, "empty-ignore");
  const reportPath = path.join(temporaryRoot, "report.json");
  const scannerConfigPath = path.join(temporaryRoot, "release-gitleaks.toml");
  writeFileSync(ignorePath, "", { mode: 0o600 });
  // The base config is also the frozen historical public-export scanner
  // policy, so do not mutate it to accommodate a release-artifact false
  // positive. Derive a release-only config which allows Supabase's explicitly
  // browser-visible publishable-key shape and only the hosted-runner build
  // root emitted into Apple's exact top-level UUID symbol-map sidecars. The
  // symbol-map exception targets only instafy-absolute-personal-path; secret-key,
  // private-marker and every other rule still scan those bytes.
  writeFileSync(
    scannerConfigPath,
    releaseArtifactScannerConfig(readFileSync(configPath, "utf8")),
    { mode: 0o600 },
  );

  try {
    const scan = run(
      executable,
      [
        "dir",
        ".",
        "--config",
        scannerConfigPath,
        "--exit-code=1",
        "--gitleaks-ignore-path",
        ignorePath,
        "--ignore-gitleaks-allow",
        "--log-level=error",
        "--max-archive-depth=1",
        "--max-decode-depth=3",
        "--max-target-megabytes=0",
        "--no-banner",
        "--no-color",
        "--redact=100",
        "--report-format=json",
        "--report-path",
        reportPath,
        // Upper bound, not a budget: a healthy scan finishes far sooner.
        "--timeout=290",
      ],
      { cwd: releaseRoot, timeout: 300_000 },
    );
    if (scan.error?.code === "ETIMEDOUT") {
      throw new Error("The Gitleaks release scan timed out");
    }
    if (scan.error) {
      throw new Error("The Gitleaks release scan could not run");
    }

    let findings;
    try {
      findings = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      throw new Error("Gitleaks did not produce a valid required report");
    }
    if (!Array.isArray(findings)) {
      throw new Error("Gitleaks produced an invalid report shape");
    }
    if (scan.status === 0 && findings.length === 0) {
      return { ok: true, findings: 0 };
    }
    if (scan.status === 1 && findings.length > 0) {
      // A bare count cannot be acted on: it says a signed release is blocked
      // without saying whether a private marker really leaked or a bundled
      // third-party file merely looks like one. Rule id, path and line are
      // identifiers, not secrets, and the matched text stays redacted by
      // --redact=100 — so report those and keep the guarantee.
      const detail = findings
        .slice(0, 20)
        .map((finding) => {
          const rule = typeof finding?.RuleID === "string" ? finding.RuleID : "unknown-rule";
          const file = typeof finding?.File === "string" ? finding.File : "unknown-file";
          const line = Number.isInteger(finding?.StartLine) ? finding.StartLine : "?";
          return `  ${rule}\t${file}:${line}`;
        })
        .join("\n");
      const elided =
        findings.length > 20 ? `\n  … ${findings.length - 20} more` : "";
      throw new Error(
        `The release artifact contains ${findings.length} potential secret or private marker finding(s):\n${detail}${elided}`,
      );
    }
    throw new Error("The Gitleaks release scan failed closed");
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--root", "--config", "--executable"].includes(name) ||
      typeof value !== "string"
    ) {
      throw new Error(
        "Usage: gitleaks-release-artifact.mjs --root <dir> --config <file> --executable <file>",
      );
    }
    options[name.slice(2)] = value;
  }
  if (
    Object.keys(options).length !== 3 ||
    !options.root ||
    !options.config ||
    !options.executable
  ) {
    throw new Error(
      "Usage: gitleaks-release-artifact.mjs --root <dir> --config <file> --executable <file>",
    );
  }
  return options;
}

function isEntryPoint(argvPath) {
  // Compare real paths: temp and checkout roots may sit behind symlinks.
  try {
    return Boolean(argvPath) && realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    runReleaseArtifactGate(parseArguments(process.argv.slice(2)));
    console.log("Gitleaks release-artifact gate passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gitleaks gate failed");
    process.exitCode = 1;
  }
}

export {
  GITHUB_TOKEN_SHAPE_REGEX,
  parseArguments,
  releaseArtifactScannerConfig,
  runReleaseArtifactGate,
  scannerEnvironment,
};
