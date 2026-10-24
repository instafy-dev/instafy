import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  combineReleaseBumps,
  isReleaseRelevantPath,
  parseChangesetReleases,
} from "./check-changeset-pr.mjs";

test("parses package bumps and requires a non-empty summary", () => {
  assert.deepEqual(
    parseChangesetReleases(`---\n"@instafy/cli": minor\n---\n\nA breaking customer CLI change.\n`),
    [{ name: "@instafy/cli", bump: "minor" }],
  );
  assert.throws(
    () => parseChangesetReleases(`---\n"@instafy/cli": patch\n---\n\n`),
    /summary must not be empty/u,
  );
});

test("requires release intent for package bytes but not package-only tests", () => {
  assert.equal(isReleaseRelevantPath("packages/instafy-cli/src/index.ts"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-cli/README.md"), true);
  assert.equal(isReleaseRelevantPath("packages/provider-contract/provider-core.js"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-cli/test/package-artifact.test.mjs"), false);
  assert.equal(isReleaseRelevantPath("packages/provider-contract/test/contracts.test.mjs"), false);
  assert.equal(isReleaseRelevantPath("docs/CLI.md"), false);
  // the binder ships inside the CLI (dist/bind): its code is the CLI's code, its tests and examples are not
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/src/server.mjs"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/client/bind-client.js"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/bin/instafy-bind.mjs"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/LICENSE"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/README.md"), false);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/tests/server.test.mjs"), false);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/examples/hello/index.html"), false);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind-other/src/x.mjs"), false);
});

test("combines multiple changesets using the highest SemVer bump", () => {
  const combined = combineReleaseBumps([
    { releases: [{ name: "@instafy/cli", bump: "patch" }] },
    { releases: [{ name: "@instafy/cli", bump: "minor" }] },
    { releases: [{ name: "@instafy/provider-contract", bump: "patch" }] },
  ]);
  assert.deepEqual([...combined], [
    ["@instafy/cli", "minor"],
    ["@instafy/provider-contract", "patch"],
  ]);
});

test("rejects changesets for unapproved public packages", () => {
  assert.throws(
    () => combineReleaseBumps([{ releases: [{ name: "@instafy/unknown", bump: "patch" }] }]),
    /unapproved package/u,
  );
});

function versionPullRequestRepository(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changeset-version-pr-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  const manifest = { name: "@instafy/cli", version: "0.2.4", scripts: { test: "node --test" } };
  write("packages/instafy-cli/package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write(".changeset/brave-fix.md", `---\n"@instafy/cli": patch\n---\n\nFix a customer bug.\n`);
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  fs.rmSync(path.join(dir, ".changeset/brave-fix.md"));
  write("packages/instafy-cli/package.json", `${JSON.stringify(edit({ ...manifest, version: "0.2.5" }), null, 2)}\n`);
  write("packages/instafy-cli/CHANGELOG.md", "# @instafy/cli\n\n## 0.2.5\n\n- Fix a customer bug.\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "chore(release): version npm packages");
  return { dir, base, head: git("rev-parse", "HEAD") };
}

function runVersionPolicy({ dir, base, head }) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check-changeset-pr.mjs", import.meta.url)), "--base", base, "--head", head, "--version-pr"],
    { cwd: dir, encoding: "utf8" },
  );
}

test("accepts a generated version pull request that changes only the version", () => {
  const repository = versionPullRequestRepository((manifest) => manifest);
  try {
    const result = runVersionPolicy(repository);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(repository.dir, { recursive: true, force: true });
  }
});

test("rejects a version pull request that changes any other manifest field", () => {
  for (const edit of [
    (manifest) => ({ ...manifest, scripts: { ...manifest.scripts, postinstall: "node evil.js" } }),
    (manifest) => ({ ...manifest, dependencies: { "left-pad": "1.3.0" } }),
    (manifest) => ({ ...manifest, bin: { instafy: "evil.js" } }),
    ({ scripts, ...manifest }) => manifest,
  ]) {
    const repository = versionPullRequestRepository(edit);
    try {
      const result = runVersionPolicy(repository);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /package\.json may change only its version/u);
    } finally {
      fs.rmSync(repository.dir, { recursive: true, force: true });
    }
  }
});
