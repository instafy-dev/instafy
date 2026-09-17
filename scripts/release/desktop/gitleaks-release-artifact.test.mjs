import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  return {
    root,
    release,
    config,
    scanner,
  };
}

test("release artifact gate accepts an exact scanner and empty report", () => {
  const item = fixture({});
  try {
    assert.deepEqual(
      runReleaseArtifactGate({
        root: item.release,
        config: item.config,
        executable: item.scanner,
      }),
      { ok: true, findings: 0 },
    );
  } finally {
    rmSync(item.root, { force: true, recursive: true });
  }
});

test("release artifact gate fails closed without exposing findings", () => {
  const item = fixture({
    findings: [{ RuleID: "private-marker", Secret: "do-not-print" }],
    status: 1,
  });
  try {
    assert.throws(
      () =>
        runReleaseArtifactGate({
          root: item.release,
          config: item.config,
          executable: item.scanner,
        }),
      (error) => {
        assert.match(error.message, /1 potential secret/u);
        assert.doesNotMatch(error.message, /do-not-print/u);
        return true;
      },
    );
  } finally {
    rmSync(item.root, { force: true, recursive: true });
  }
});

test("release artifact gate rejects scanner version drift", () => {
  const item = fixture({ version: "8.30.2" });
  try {
    assert.throws(
      () =>
        runReleaseArtifactGate({
          root: item.release,
          config: item.config,
          executable: item.scanner,
        }),
      /version does not match/u,
    );
  } finally {
    rmSync(item.root, { force: true, recursive: true });
  }
});

test("release scanner allowlists only Supabase publishable-key values", () => {
  const config = releaseArtifactScannerConfig("[extend]\nuseDefault = true\n");
  assert.match(config, /targetRules = \["generic-api-key"\]/u);

  const patternSource = config.match(
    /regexes = \['''(\^sb_publishable_[^']+\$)'''\]/u,
  )?.[1];
  assert.ok(
    patternSource,
    "release config must contain the anchored publishable-key pattern",
  );
  const pattern = new RegExp(patternSource, "u");

  assert.equal(
    pattern.test("sb_publishable_Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"),
    true,
  );
  assert.equal(
    pattern.test(
      ["sb", "secret", "Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"].join("_"),
    ),
    false,
  );
  assert.equal(pattern.test("Q7mX2vK9pR4tN8zL3cW6yH1fJ5dB0sA"), false);
});

test("release scanner suppresses personal paths only in exact Xcode symbol maps", () => {
  const config = releaseArtifactScannerConfig("[extend]\nuseDefault = true\n");
  const allowlist = config.match(
    /description = "Xcode symbol maps may contain hosted macOS build roots"[\s\S]*?condition = "AND"[\s\S]*?regexTarget = "line"[\s\S]*?targetRules = \["instafy-absolute-personal-path"\][\s\S]*?paths = \['''([^']+)'''\][\s\S]*?regexes = \['''([^']+)'''\]/u,
  );
  assert.ok(allowlist, "release config must contain the Xcode symbol-map allowlist");
  const pathPattern = new RegExp(allowlist[1], "u");
  const linePattern = new RegExp(allowlist[2], "u");
  const uuid = "9E2C174F-C333-3FA8-BBD3-76CE61220D22";

  assert.equal(
    pathPattern.test(`instafy-release.ipa.zip!Symbols/${uuid}.symbols`),
    true,
  );
  assert.equal(
    pathPattern.test(`instafy-release.ipa.zip!Payload/App.app/${uuid}.symbols`),
    false,
  );
  assert.equal(pathPattern.test(`other.ipa.zip!Symbols/${uuid}.symbols`), false);
  assert.equal(
    pathPattern.test("instafy-release.ipa.zip!Symbols/not-a-uuid.symbols"),
    false,
  );
  const home = ["", ["U", "sers"].join("")].join("/");
  assert.equal(linePattern.test(`${home}/runner/work/instafy`), true);
  assert.equal(linePattern.test(`${home}/someone/git/instafy`), false);
});

test("CLI arguments and scanner environment are allowlisted", () => {
  assert.deepEqual(
    parseArguments([
      "--root",
      "/tmp/release",
      "--config",
      "/tmp/gitleaks.toml",
      "--executable",
      "/tmp/gitleaks",
    ]),
    {
      root: "/tmp/release",
      config: "/tmp/gitleaks.toml",
      executable: "/tmp/gitleaks",
    },
  );
  assert.throws(() => parseArguments(["--unknown", "value"]), /Usage/u);
  assert.equal(scannerEnvironment().GITHUB_TOKEN, undefined);
  assert.equal(scannerEnvironment().GH_TOKEN, undefined);
});

test("every allowlist target rule exists in the public base scanner config", async () => {
  const { readFileSync } = await import("node:fs");
  const base = readFileSync(
    path.join(import.meta.dirname, "..", "..", "public-boundary-gitleaks.toml"),
    "utf8",
  );
  const derived = releaseArtifactScannerConfig(base);
  const targets = [...derived.matchAll(/^targetRules = \["([^"]+)"\]$/gmu)].map((match) => match[1]);
  assert.deepEqual(targets, ["generic-api-key", "instafy-absolute-personal-path"]);
  assert.match(base, /^id = "instafy-absolute-personal-path"$/mu);
  assert.match(base, /^id = "generic-api-key"$/mu);
});
