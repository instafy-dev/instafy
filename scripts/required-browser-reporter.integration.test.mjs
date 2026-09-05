import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserCiEnvironment } from "../packages/frontend/scripts/browser-ci.mjs";
import { REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(path.join(repoRoot, "packages/frontend/package.json"));
// Resolve the installed, lockfile-selected runner. Missing dependencies must
// fail this gate, never skip it or download another Playwright version.
const playwrightCli = frontendRequire.resolve("@playwright/test/cli");
const playwrightTest = frontendRequire.resolve("@playwright/test");
const reporterPath = path.join(repoRoot, "packages/frontend/scripts/required-browser-reporter.mjs");
const titles = REQUIRED_BROWSER_LANES.personal.titles;

function runFixture(t, { scenario = "passing", args = [] } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-required-browser-process-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const outputDir = path.join(fixtureRoot, "results");
  const configPath = path.join(fixtureRoot, "playwright.config.mjs");
  fs.writeFileSync(configPath, `export default ${JSON.stringify({
    testDir: fixtureRoot,
    testMatch: "electron-personal-browser.spec.ts",
    forbidOnly: true,
    fullyParallel: false,
    workers: 1,
    retries: scenario === "retry" ? 1 : 0,
    timeout: 5_000,
    globalTimeout: 15_000,
    outputDir,
    reporter: [[reporterPath, { lane: "personal" }]],
  }, null, 2)};\n`);
  const cases = titles.map((title, index) => {
    const method = scenario === "skipped" ? "test.skip" : "test";
    let body = "expect(true).toBe(true);";
    if (index === 0 && scenario === "expected-failure") {
      body = "test.fail(); expect(false).toBe(true);";
    } else if (index === 0 && scenario === "retry") {
      body = "expect(testInfo.retry).toBe(1);";
    }
    return `${method}(${JSON.stringify(title)}, async ({}, testInfo) => { ${body} });`;
  });
  // These fixtures prove the reporter/runner exit contract only. They use no
  // page/browser fixtures, service endpoints, accounts, or model providers.
  fs.writeFileSync(path.join(fixtureRoot, "electron-personal-browser.spec.ts"),
    `const { test, expect } = require(${JSON.stringify(playwrightTest)});\n${cases.join("\n")}\n`);

  const result = spawnSync(process.execPath, [playwrightCli, "test", "--config", configPath, ...args], {
    cwd: fixtureRoot,
    env: browserCiEnvironment(),
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Playwright terminated unexpectedly: ${result.stderr}`);
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  const receiptPath = path.join(outputDir, "required-browser-result.json");
  assert.ok(fs.existsSync(receiptPath), `Required reporter did not write a receipt:\n${diagnostic}`);
  return { result, diagnostic, receipt: JSON.parse(fs.readFileSync(receiptPath, "utf8")) };
}

function expectRejected(run) {
  assert.notEqual(run.result.status, 0, `Reporter accepted an invalid lane:\n${run.diagnostic}`);
  assert.equal(run.receipt.status, "failed");
  assert.ok(run.receipt.failures.length > 0);
}

test("required browser reporter permits four actual first-attempt passes in Playwright", (t) => {
  const run = runFixture(t);
  assert.equal(run.result.status, 0, run.diagnostic);
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.receipt.selected, 4);
  assert.equal(run.receipt.passed, 4);
  assert.equal(run.receipt.skipped, 0);
});

test("required browser reporter makes an all-skipped Playwright run exit nonzero", (t) => {
  const run = runFixture(t, { scenario: "skipped" });
  expectRejected(run);
  assert.equal(run.receipt.selected, 4);
  assert.equal(run.receipt.skipped, 4);
  assert.equal(run.receipt.passed, 0);
});

test("required browser reporter rejects a passing grep subset missing required cases", (t) => {
  const run = runFixture(t, { args: ["--grep", "explicit kill switch"] });
  expectRejected(run);
  assert.equal(run.receipt.selected, 1);
  assert.equal(run.receipt.passed, 1);
});

test("required browser reporter overrides pass-with-no-tests for an empty selection", (t) => {
  const run = runFixture(t, { args: ["--grep", "no-fixture-test-matches-this", "--pass-with-no-tests"] });
  expectRejected(run);
  assert.equal(run.receipt.selected, 0);
  assert.equal(run.receipt.passed, 0);
});

test("required browser reporter rejects an expected failure that Playwright accepts", (t) => {
  const run = runFixture(t, { scenario: "expected-failure" });
  expectRejected(run);
  assert.equal(run.receipt.selected, 4);
  assert.equal(run.receipt.tests[0].expectedStatus, "failed");
  assert.deepEqual(run.receipt.tests[0].attempts, [{ status: "failed", retry: 0 }]);
});

test("required browser reporter rejects a failed first attempt followed by a passing retry", (t) => {
  const run = runFixture(t, { scenario: "retry" });
  expectRejected(run);
  assert.equal(run.receipt.selected, 4);
  assert.deepEqual(run.receipt.tests[0].attempts, [
    { status: "failed", retry: 0 },
    { status: "passed", retry: 1 },
  ]);
});
