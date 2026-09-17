import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseArguments,
  releaseArtifactScannerConfig,
  runReleaseArtifactGate,
  scannerEnvironment,
} from "./gitleaks-release-artifact.mjs";

function fixture({ version = "8.30.1", findings = [], status = 0 }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ota-gitleaks-test-"));
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

function withFixture(options, body) {
  const item = fixture(options);
  try {
    body(item);
  } finally {
    rmSync(item.root, { force: true, recursive: true });
  }
}

test("gate accepts the exact scanner and an empty report", () => {
  withFixture({}, (item) => {
    assert.deepEqual(
      runReleaseArtifactGate({ root: item.release, config: item.config, executable: item.scanner }),
      { ok: true, findings: 0 },
    );
  });
});

test("gate fails closed on findings without printing the matched secret", () => {
  withFixture({ findings: [{ RuleID: "private-key", File: "a.js", StartLine: 3, Secret: "do-not-print" }], status: 1 }, (item) => {
    assert.throws(
      () => runReleaseArtifactGate({ root: item.release, config: item.config, executable: item.scanner }),
      (error) => {
        assert.match(error.message, /1 potential secret/u);
        assert.match(error.message, /private-key\ta\.js:3/u);
        assert.doesNotMatch(error.message, /do-not-print/u);
        return true;
      },
    );
  });
});

test("gate rejects scanner version drift and inconsistent exit codes", () => {
  withFixture({ version: "8.30.2" }, (item) => {
    assert.throws(
      () => runReleaseArtifactGate({ root: item.release, config: item.config, executable: item.scanner }),
      /version does not match/u,
    );
  });
  withFixture({ status: 1 }, (item) => {
    assert.throws(
      () => runReleaseArtifactGate({ root: item.release, config: item.config, executable: item.scanner }),
      /failed closed/u,
    );
  });
});

test("release config allowlists only publishable Supabase keys and targets the public path rule", () => {
  const config = releaseArtifactScannerConfig("[extend]\nuseDefault = true\n");
  const publishable = new RegExp(config.match(/regexes = \['''(\^sb_publishable_[^']+\$)'''\]/u)[1], "u");
  assert.equal(publishable.test("sb_publishable_Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"), true);
  assert.equal(publishable.test(["sb", "secret", "Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"].join("_")), false);
  assert.match(config, /targetRules = \["instafy-absolute-personal-path"\]/u);
  assert.doesNotMatch(config, /"instafy-personal-path"/u);
  const line = new RegExp(config.match(/regexes = \['''([^']*runner[^']*)'''\]/u)[1], "u");
  assert.equal(line.test(["", "Users", "runner", "work"].join("/")), true);
  assert.equal(line.test(["", "Users", "someone", "work"].join("/")), false);
  assert.throws(() => releaseArtifactScannerConfig(""), /must not be empty/u);
});

test("argument parsing and scanner environment are strict", () => {
  assert.deepEqual(parseArguments(["--root", "r", "--config", "c", "--executable", "e"]), {
    root: "r",
    config: "c",
    executable: "e",
  });
  assert.throws(() => parseArguments(["--root", "r"]), /Usage/u);
  assert.throws(() => parseArguments(["--token", "x", "--config", "c", "--executable", "e"]), /Usage/u);
  const saved = process.env.OTA_SIGNING_PRIVATE_KEY;
  process.env.OTA_SIGNING_PRIVATE_KEY = "never-forwarded";
  try {
    assert.equal(Object.hasOwn(scannerEnvironment(), "OTA_SIGNING_PRIVATE_KEY"), false);
  } finally {
    if (saved === undefined) delete process.env.OTA_SIGNING_PRIVATE_KEY;
    else process.env.OTA_SIGNING_PRIVATE_KEY = saved;
  }
});
