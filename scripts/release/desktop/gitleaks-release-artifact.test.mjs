import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GITHUB_TOKEN_SHAPE_REGEX,
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
  // Generated at test time so the source tree carries no key-shaped literal.
  const keyBody = randomBytes(24).toString("base64url").replace(/[-_]/gu, "A");

  assert.equal(pattern.test(["sb", "publishable", keyBody].join("_")), true);
  assert.equal(pattern.test(["sb", "secret", keyBody].join("_")), false);
  assert.equal(pattern.test(keyBody), false);
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

function baseScannerConfig() {
  return readFileSync(
    path.join(import.meta.dirname, "..", "..", "public-boundary-gitleaks.toml"),
    "utf8",
  );
}

function ruleBlocks(config) {
  return config.split(/(?=^\[\[)/mu);
}

function tokenRuleRegex(config) {
  const blocks = ruleBlocks(config).filter((block) =>
    /^id = "instafy-github-token-prefix"$/mu.test(block),
  );
  assert.equal(blocks.length, 1);
  const lines = blocks[0].match(/^regex = '''(.*)'''$/gmu) ?? [];
  assert.equal(lines.length, 1);
  return lines[0].slice("regex = '''".length, -"'''".length);
}

// Built at runtime so no credential-looking literal sits in the repository.
const tokenPrefix = (letter) => ["gh", letter, "_"].join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function seededBytes(length, seed) {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

test("release scan uses the GitHub token shape, not the frozen bare-prefix rule", () => {
  const base = baseScannerConfig();
  const derived = releaseArtifactScannerConfig(base);
  assert.equal(tokenRuleRegex(derived), GITHUB_TOKEN_SHAPE_REGEX);
  assert.notEqual(tokenRuleRegex(base), GITHUB_TOKEN_SHAPE_REGEX);
  const ids = (text) => [...text.matchAll(/^id = "([^"]+)"$/gmu)].map((match) => match[1]);
  assert.deepEqual(ids(derived), ids(base));
  const untouched = (text) =>
    ruleBlocks(text).filter((block) => !/instafy-github-token-prefix/u.test(block)).join("");
  assert.equal(untouched(derived).startsWith(untouched(base)), true);
});

test("a four-byte token prefix inside binary noise is not a release finding", () => {
  const shape = new RegExp(GITHUB_TOKEN_SHAPE_REGEX, "u");
  const bare = new RegExp(tokenRuleRegex(baseScannerConfig()), "u");
  for (let seed = 1; seed <= 64; seed += 1) {
    const noise = seededBytes(4096, seed);
    const offset = 512 + ((seed * 37) % 2048);
    Buffer.from(tokenPrefix("p"), "latin1").copy(noise, offset);
    // Four random bytes, then binary: the shape of the observed DMG false positive.
    seededBytes(4, seed * 7919).copy(noise, offset + 4);
    noise[offset + 8] = 0;
    const text = noise.toString("latin1");
    assert.equal(bare.test(text), true, "the frozen prefix rule would have fired");
    assert.equal(shape.test(text), false, `seed ${seed} produced a false positive`);
  }
});

test("real GitHub token shapes are still release findings", () => {
  const shape = new RegExp(GITHUB_TOKEN_SHAPE_REGEX, "u");
  const binary = String.fromCharCode(0, 1);
  const body = (length) =>
    Array.from({ length }, (_, index) => ALNUM[(index * 11) % ALNUM.length]).join("");
  for (const letter of ["p", "o", "u", "s", "r"]) {
    assert.equal(shape.test(`${binary}${tokenPrefix(letter)}${body(36)}${binary}`), true, letter);
    assert.equal(shape.test(`${tokenPrefix(letter)}${body(35)}${binary}`), false, letter);
  }
  assert.equal(shape.test(["github", "pat", body(70)].join("_")), true);
});

test("token rule is added when the base lacks it and rejected when duplicated", () => {
  const minimal = "[extend]\nuseDefault = true\n";
  assert.equal(tokenRuleRegex(releaseArtifactScannerConfig(minimal)), GITHUB_TOKEN_SHAPE_REGEX);
  const rule = "[[rules]]\nid = \"instafy-github-token-prefix\"\nregex = '''x'''\n\n";
  assert.throws(() => releaseArtifactScannerConfig(minimal + rule + rule), /more than once/u);
});
