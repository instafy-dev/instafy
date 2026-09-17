#!/usr/bin/env node
// Scans a signed release artifact (the AAB, copied under a .zip alias so the
// archive detector inspects its entries) with the pinned Gitleaks scanner and
// the public boundary config. Findings are reported by rule, file and line
// only; matched text stays redacted.

import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REQUIRED_VERSION = "8.30.1";
const MAX_BUFFER = 16 * 1024 * 1024;
const SAFE_ENV_NAMES = new Set([
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "USER",
]);

// The Android bundle has no Xcode symbol maps, so unlike the iOS lane this
// lane derives no path exception: every personal-path finding fails the scan.
const RELEASE_ARTIFACT_ALLOWLIST = String.raw`
[[allowlists]]
description = "Supabase publishable keys are intentionally browser-visible"
targetRules = ["generic-api-key"]
regexes = ['''^sb_publishable_[A-Za-z0-9_-]{20,}$''']
`;

function scannerEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => value !== undefined && SAFE_ENV_NAMES.has(name)),
  );
}

function requirePlainPath(candidate, kind) {
  const resolved = path.resolve(candidate);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${kind} must not be a symbolic link`);
  if ((kind === "release root" && !stat.isDirectory()) || (kind === "Gitleaks config" && !stat.isFile())) {
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
    ...options,
  });
}

function releaseArtifactScannerConfig(baseConfig) {
  if (typeof baseConfig !== "string" || baseConfig.trim().length === 0) {
    throw new Error("The base Gitleaks config must not be empty");
  }
  const separator = baseConfig.endsWith("\n") ? "\n" : "\n\n";
  return `${baseConfig}${separator}${RELEASE_ARTIFACT_ALLOWLIST.trimStart()}`;
}

function runReleaseArtifactGate({ root, config, executable, expectedVersion = REQUIRED_VERSION }) {
  const releaseRoot = requirePlainPath(root, "release root");
  const configPath = requirePlainPath(config, "Gitleaks config");
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("A pinned Gitleaks executable is required");
  }
  const version = run(executable, ["version"]);
  if (version.error || version.status !== 0) throw new Error("The pinned Gitleaks scanner could not run");
  if (version.stdout.trim() !== expectedVersion) {
    throw new Error("The Gitleaks scanner version does not match the release pin");
  }

  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "instafy-release-gitleaks-"));
  chmodSync(temporaryRoot, 0o700);
  const ignorePath = path.join(temporaryRoot, "empty-ignore");
  const reportPath = path.join(temporaryRoot, "report.json");
  const scannerConfigPath = path.join(temporaryRoot, "release-gitleaks.toml");
  writeFileSync(ignorePath, "", { mode: 0o600 });
  // Never mutate the repository boundary config; derive a release-only copy.
  writeFileSync(scannerConfigPath, releaseArtifactScannerConfig(readFileSync(configPath, "utf8")), { mode: 0o600 });

  try {
    const scan = run(
      executable,
      [
        "dir", ".",
        "--config", scannerConfigPath,
        "--exit-code=1",
        "--gitleaks-ignore-path", ignorePath,
        "--ignore-gitleaks-allow",
        "--log-level=error",
        "--max-archive-depth=1",
        "--max-decode-depth=3",
        "--max-target-megabytes=0",
        "--no-banner",
        "--no-color",
        "--redact=100",
        "--report-format=json",
        "--report-path", reportPath,
        "--timeout=290",
      ],
      { cwd: releaseRoot, timeout: 300_000 },
    );
    if (scan.error?.code === "ETIMEDOUT") throw new Error("The Gitleaks release scan timed out");
    if (scan.error) throw new Error("The Gitleaks release scan could not run");
    let findings;
    try {
      findings = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      throw new Error("Gitleaks did not produce a valid required report");
    }
    if (!Array.isArray(findings)) throw new Error("Gitleaks produced an invalid report shape");
    if (scan.status === 0 && findings.length === 0) return { ok: true, findings: 0 };
    if (scan.status === 1 && findings.length > 0) {
      const detail = findings.slice(0, 20).map((finding) => {
        const rule = typeof finding?.RuleID === "string" ? finding.RuleID : "unknown-rule";
        const file = typeof finding?.File === "string" ? finding.File : "unknown-file";
        const line = Number.isInteger(finding?.StartLine) ? finding.StartLine : "?";
        return `  ${rule}\t${file}:${line}`;
      }).join("\n");
      const elided = findings.length > 20 ? `\n  ... ${findings.length - 20} more` : "";
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
  const usage = "Usage: gitleaks-release-artifact.mjs --root <dir> --config <file> --executable <file>";
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--root", "--config", "--executable"].includes(name) || typeof value !== "string" || !value) {
      throw new Error(usage);
    }
    options[name.slice(2)] = value;
  }
  if (Object.keys(options).length !== 3) throw new Error(usage);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    runReleaseArtifactGate(parseArguments(process.argv.slice(2)));
    console.log("Gitleaks release-artifact gate passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gitleaks gate failed");
    process.exitCode = 1;
  }
}

export { parseArguments, releaseArtifactScannerConfig, runReleaseArtifactGate, scannerEnvironment };
