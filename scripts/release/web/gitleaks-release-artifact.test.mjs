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
import { fileURLToPath } from "node:url";

import {
  RELEASE_TOKEN_REGEX,
  parseArguments,
  releaseArtifactScannerConfig,
  runReleaseArtifactGate,
  scannerEnvironment,
} from "./gitleaks-release-artifact.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASE_CONFIG = "[extend]\nuseDefault = true\n\n[[rules]]\nid = \"instafy-github-token-prefix\"\nregex = '''(?:gh[p]_)'''\n";

function fixture({ version = "8.30.1", findings = [], status = 0 }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "instafy-gitleaks-test-"));
  const release = path.join(root, "release");
  const config = path.join(root, "gitleaks.toml");
  const scanner = path.join(root, "gitleaks");
  writeFileSync(config, BASE_CONFIG);
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
  const config = releaseArtifactScannerConfig(BASE_CONFIG);
  assert.match(config, /targetRules = \["generic-api-key"\]/u);

  const patternSource = config.match(
    /regexes = \['''(\^sb_publishable_[^']+\$)'''\]/u,
  )?.[1];
  assert.ok(
    patternSource,
    "release config must contain the anchored publishable-key pattern",
  );
  const pattern = new RegExp(patternSource, "u");
  // Generated at runtime so repository secret scanners never see a key-shaped literal.
  const keyBody = randomBytes(24).toString("hex");

  assert.equal(
    pattern.test(["sb", "publishable", keyBody].join("_")),
    true,
  );
  assert.equal(
    pattern.test(
      ["sb", "secret", keyBody].join("_"),
    ),
    false,
  );
  assert.equal(pattern.test(keyBody), false);
});

test("release scanner allows the product marker only in top-level JavaScript chunks", () => {
  const config = releaseArtifactScannerConfig(BASE_CONFIG);
  const allowlist = config.match(
    /targetRules = \["instafy-private-product"\]\npaths = \['''([^']+)'''\]/u,
  );
  assert.ok(allowlist, "release config must scope the product-marker allowlist by path");
  const pathPattern = new RegExp(allowlist[1], "u");
  assert.equal(pathPattern.test("assets/index-AbC_12-x.js"), true);
  for (const candidate of ["index.html", "instafy-build.json", "assets/index-AbC.css", "assets/nested/chunk.js", "assets/chunk.js.map", "x/assets/chunk.js"]) {
    assert.equal(pathPattern.test(candidate), false, candidate);
  }
  assert.equal((config.match(/targetRules = \["instafy-private-product"\]/gu) ?? []).length, 1);
  assert.doesNotMatch(config, /disabledRules/u);
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

test("release scanner replaces the bare GitHub token prefix with the full-token rule", () => {
  const base = readFileSync(path.join(repositoryRoot, "scripts", "public-boundary-gitleaks.toml"), "utf8");
  const config = releaseArtifactScannerConfig(base);
  const split = (text) => text.split(/(?=^\[\[)/mu);
  const baseBlocks = split(base);
  const releaseBlocks = split(config);
  assert.equal(releaseBlocks.length, baseBlocks.length + 2, "only the two release allowlist blocks are appended");
  let replaced = 0;
  baseBlocks.forEach((block, index) => {
    if (/^id = "instafy-github-token-prefix"$/mu.test(block)) {
      replaced += 1;
      assert.equal(releaseBlocks[index].match(/^regex = '''(.*)'''$/mu)?.[1], RELEASE_TOKEN_REGEX);
      assert.equal(releaseBlocks[index].replace(/^regex = .*$/mu, ""), block.replace(/^regex = .*$/mu, ""));
    } else {
      assert.equal(releaseBlocks[index].trimEnd(), block.trimEnd(), "every other rule is carried over unchanged");
    }
  });
  assert.equal(replaced, 1);

  const pattern = new RegExp(RELEASE_TOKEN_REGEX, "u");
  const body = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
  for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
    assert.equal(pattern.test([prefix, body].join("_")), true, prefix);
  }
  assert.equal(pattern.test(["github", "pat", "x".repeat(70)].join("_")), true);
  // Four chance bytes of compressed noise followed by binary are not a token.
  const bare = ["gh", "p_"].join("");
  assert.equal(pattern.test(bare + String.fromCharCode(0, 255, 19) + "binary"), false);
  assert.equal(pattern.test(bare + "short"), false);
});

test("release scanner fails closed when the token rule is missing, duplicated or not single-line", () => {
  const rule = (regex) => "[[rules]]\nid = \"instafy-github-token-prefix\"\n" + regex + "\n";
  assert.throws(() => releaseArtifactScannerConfig("[extend]\nuseDefault = true\n"), /exactly one instafy-github-token-prefix/u);
  assert.throws(
    () => releaseArtifactScannerConfig(rule("regex = '''a'''") + "\n" + rule("regex = '''b'''")),
    /exactly one instafy-github-token-prefix/u,
  );
  assert.throws(() => releaseArtifactScannerConfig(rule("regex = \"a\"")), /single-line regex/u);
});
