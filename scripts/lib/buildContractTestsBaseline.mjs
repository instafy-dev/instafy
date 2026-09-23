import assert from "node:assert/strict";

// Test-only inverse of the node --test files added to the Build workflow's
// "Test public migration and self-host contracts" step after its whole-file
// baselines were reviewed; not runtime authority. Every entry must be present
// exactly once, so dropping one from CI fails here instead of passing quietly.
export const ADDED_BUILD_CONTRACT_TESTS = ["scripts/lib/localUserTokenSecret.test.mjs"];

export const addedBuildContractTestLine = (file) => `            ${file} \\\n`;

export function withoutAddedBuildContractTests(source) {
  for (const file of ADDED_BUILD_CONTRACT_TESTS) {
    const line = addedBuildContractTestLine(file);
    assert.equal(source.split(line).length, 2, `${file} must run exactly once in build.yml`);
    source = source.replace(line, "");
  }
  return source;
}
