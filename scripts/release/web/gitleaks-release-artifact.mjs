#!/usr/bin/env node
// Hosted web lane copy of the release-artifact Gitleaks gate (one copy per lane
// by design): the public boundary config, the full GitHub token shape, and
// release-artifact-only allowlists. The bundled JavaScript legitimately carries
// the robot integration's wire identifiers, so the product-marker rule is
// allowed for top-level assets/*.js only; index.html, CSS, metadata and every
// other rule still scan every byte.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
description = "Hosted web JavaScript chunks carry the robot integration's public wire identifiers"
targetRules = ["instafy-private-product"]
paths = ['''^assets/[A-Za-z0-9_.-]+\.js$''']
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

function releaseArtifactScannerConfig(baseConfig) {
  if (typeof baseConfig !== "string" || baseConfig.trim().length === 0) {
    throw new Error("The base Gitleaks config must not be empty");
  }
  const releaseConfig = strictTokenRule(baseConfig);
  const separator = releaseConfig.endsWith("\n") ? "\n" : "\n\n";
  return `${releaseConfig}${separator}${RELEASE_ARTIFACT_ALLOWLIST.trimStart()}`;
}

// The repository gate matches the bare GitHub token prefix. That is right for
// source text but hits by chance in large binaries: the first hosted iOS dry
// run matched it inside an Xcode .symbols file in the IPA. Release artifacts
// therefore scan with the full token body, the same rule the Desktop and
// Android lanes use. Every real token shape still matches, including
// ghu_/ghs_/ghr_, which the bare prefix missed.
const TOKEN_RULE_ID = "instafy-github-token-prefix";
const RELEASE_TOKEN_REGEX = String.raw`(?:gh[pousr]_[A-Za-z0-9]{36,}|github_[p]at_[A-Za-z0-9_]{60,})`;
const RULE_BLOCK_SPLIT = /(?=^\[\[)/mu;
const TOKEN_RULE_ID_LINE = new RegExp(`^id = "${TOKEN_RULE_ID}"$`, "mu");
const SINGLE_LINE_REGEX = /^regex = '''.*'''$/gmu;

function strictTokenRule(baseConfig) {
  const blocks = baseConfig.split(RULE_BLOCK_SPLIT);
  const indexes = blocks
    .map((block, index) => (block.startsWith("[[rules]]") && TOKEN_RULE_ID_LINE.test(block) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length !== 1) {
    throw new Error(`The base Gitleaks config must define exactly one ${TOKEN_RULE_ID} rule`);
  }
  const block = blocks[indexes[0]];
  const regexLines = block.match(SINGLE_LINE_REGEX) ?? [];
  if (regexLines.length !== 1) {
    throw new Error(`The ${TOKEN_RULE_ID} rule must have exactly one single-line regex`);
  }
  blocks[indexes[0]] = block.replace(regexLines[0], () => `regex = '''${RELEASE_TOKEN_REGEX}'''`);
  return blocks.join("");
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runReleaseArtifactGate(parseArguments(process.argv.slice(2)));
    console.log("Gitleaks release-artifact gate passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gitleaks gate failed");
    process.exitCode = 1;
  }
}

export {
  parseArguments,
  RELEASE_TOKEN_REGEX,
  releaseArtifactScannerConfig,
  runReleaseArtifactGate,
  scannerEnvironment,
};
