import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseArguments,
  releaseArtifactScannerConfig,
  runReleaseArtifactGate,
  scannerEnvironment,
} from "./gitleaks-release-artifact.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");

function fixture({ version = "8.30.1", findings = [], status = 0 }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "instafy-gitleaks-test-"));
  const release = path.join(root, "release");
  const config = path.join(root, "gitleaks.toml");
  const scanner = path.join(root, "gitleaks");
  writeFileSync(config, "[extend]\nuseDefault = true\n");
  writeFileSync(
    scanner,
    `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
report=''
previous=''
for argument in "$@"; do
  if [ "$previous" = "--report-path" ]; then report="$argument"; fi
  previous="$argument"
done
printf '%s\\n' '${JSON.stringify(findings)}' > "$report"
exit ${status}
`,
  );
  chmodSync(scanner, 0o700);
  mkdirSync(release);
  return { root, release, config, scanner };
}

test("release artifact gate accepts an exact scanner and empty report", () => {
  const item = fixture({});
  try {
    assert.deepEqual(
      runReleaseArtifactGate({ root: item.release, config: item.config, executable: item.scanner }),
      { ok: true, findings: 0 },
    );
  } finally {
    rmSync(item.root, { force: true, recursive: true });
  }
});

test("release artifact gate fails closed without exposing findings", () => {
  const item = fixture({ findings: [{ RuleID: "private-marker", File: "instafy-release.aab.zip!base/x", StartLine: 3, Secret: "do-not-print" }], status: 1 });
  try {
    assert.throws(
      () => runReleaseArtifactGate({ root: item.release, config: item.config, executable: item.scanner }),
      (error) => {
        assert.match(error.message, /1 potential secret/u);
        assert.match(error.message, /private-marker\tinstafy-release\.aab\.zip!base\/x:3/u);
        assert.doesNotMatch(error.message, /do-not-print/u);
        return true;
      },
    );
  } finally {
    rmSync(item.root, { force: true, recursive: true });
  }
});

test("release artifact gate rejects scanner version drift and inconsistent reports", () => {
  const drift = fixture({ version: "8.30.2" });
  const silent = fixture({ findings: [], status: 1 });
  try {
    assert.throws(
      () => runReleaseArtifactGate({ root: drift.release, config: drift.config, executable: drift.scanner }),
      /version does not match/u,
    );
    assert.throws(
      () => runReleaseArtifactGate({ root: silent.release, config: silent.config, executable: silent.scanner }),
      /failed closed/u,
    );
  } finally {
    rmSync(drift.root, { force: true, recursive: true });
    rmSync(silent.root, { force: true, recursive: true });
  }
});

test("release scanner allowlists only Supabase publishable-key values and no path exceptions", () => {
  const config = releaseArtifactScannerConfig(
    readFileSync(path.join(repositoryRoot, "scripts", "public-boundary-gitleaks.toml"), "utf8"),
  );
  assert.match(config, /targetRules = \["generic-api-key"\]/u);
  assert.doesNotMatch(config.split("Supabase publishable keys")[1], /paths =|absolute-personal-path/u);
  const patternSource = config.match(/regexes = \['''(\^sb_publishable_[^']+\$)'''\]/u)?.[1];
  assert.ok(patternSource, "release config must contain the anchored publishable-key pattern");
  const pattern = new RegExp(patternSource, "u");
  assert.equal(pattern.test(["sb", "publishable", "x".repeat(31)].join("_")), true);
  assert.equal(pattern.test(["sb", "secret", "x".repeat(31)].join("_")), false);
  assert.equal(pattern.test("x".repeat(31)), false);
  assert.throws(() => releaseArtifactScannerConfig(" "), /must not be empty/u);
});

test("CLI arguments and scanner environment are allowlisted", () => {
  assert.deepEqual(
    parseArguments(["--root", "/tmp/release", "--config", "/tmp/gitleaks.toml", "--executable", "/tmp/gitleaks"]),
    { root: "/tmp/release", config: "/tmp/gitleaks.toml", executable: "/tmp/gitleaks" },
  );
  assert.throws(() => parseArguments(["--unknown", "value"]), /Usage/u);
  assert.throws(() => parseArguments(["--root", "/tmp/release"]), /Usage/u);
  const previous = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = "{}";
  try {
    const env = scannerEnvironment();
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, undefined);
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = previous;
  }
});
