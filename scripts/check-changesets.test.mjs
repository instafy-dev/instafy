import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  combineReleaseBumps,
  isRegistryBootstrapTransition,
  isReleaseRelevantPath,
  parseChangesetReleases,
} from "./check-changeset-pr.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

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

test("records the one-time npm registry bootstrap without making version edits generally legal", () => {
  assert.equal(
    isRegistryBootstrapTransition("packages/instafy-cli/package.json", "0.1.12", "0.1.11"),
    true,
  );
  assert.equal(
    isRegistryBootstrapTransition("packages/provider-contract/package.json", "0.1.2", "0.1.1"),
    true,
  );
  assert.equal(
    isRegistryBootstrapTransition("packages/instafy-cli/package.json", "0.1.11", "0.1.12"),
    false,
  );
  assert.equal(
    isRegistryBootstrapTransition("packages/provider-contract/package.json", "0.1.1", "0.1.0"),
    false,
  );

  const cliManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "packages/instafy-cli/package.json"), "utf8"),
  );
  const providerManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "packages/provider-contract/package.json"), "utf8"),
  );
  assert.equal(cliManifest.version, "0.1.11");
  assert.equal(providerManifest.version, "0.1.1");

  const cliChangeset = parseChangesetReleases(
    fs.readFileSync(path.join(repositoryRoot, ".changeset/strong-customer-cli.md"), "utf8"),
  );
  const providerChangeset = parseChangesetReleases(
    fs.readFileSync(path.join(repositoryRoot, ".changeset/neutral-provider-surfaces.md"), "utf8"),
  );
  assert.deepEqual(cliChangeset, [{ name: "@instafy/cli", bump: "minor" }]);
  assert.deepEqual(providerChangeset, [
    { name: "@instafy/provider-contract", bump: "patch" },
  ]);
});
