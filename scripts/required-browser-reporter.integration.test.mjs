import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserCiEnvironment } from "../packages/frontend/scripts/browser-ci.mjs";
import { combineRequiredBrowserParts, REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";

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

test("required browser reporter permits every required case passing on its first attempt in Playwright", (t) => {
  const run = runFixture(t);
  assert.equal(run.result.status, 0, run.diagnostic);
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.receipt.selected, titles.length);
  assert.equal(run.receipt.passed, titles.length);
  assert.equal(run.receipt.skipped, 0);
});

test("required browser reporter makes an all-skipped Playwright run exit nonzero", (t) => {
  const run = runFixture(t, { scenario: "skipped" });
  expectRejected(run);
  assert.equal(run.receipt.selected, titles.length);
  assert.equal(run.receipt.skipped, titles.length);
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
  assert.equal(run.receipt.selected, titles.length);
  assert.equal(run.receipt.tests[0].expectedStatus, "failed");
  assert.deepEqual(run.receipt.tests[0].attempts, [{ status: "failed", retry: 0 }]);
});

test("required browser reporter rejects a failed first attempt followed by a passing retry", (t) => {
  const run = runFixture(t, { scenario: "retry" });
  expectRejected(run);
  assert.equal(run.receipt.selected, titles.length);
  assert.deepEqual(run.receipt.tests[0].attempts, [
    { status: "failed", retry: 0 },
    { status: "passed", retry: 1 },
  ]);
});

// The browser UI lane runs on CI as Playwright shards. Run a fixture with the
// lane's whole required inventory through real Playwright as two parts: each
// part's receipt says which part it is, and only both together meet the lane.
function runBrowserUiParts(t, { renamed } = {}) {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-required-browser-parts-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const titles = [...contract.titles.map((title) => title === renamed ? "an unrelated passing case" : title)];
  while (titles.length < contract.minimumTests) titles.push(`another browser UI case ${titles.length}`);
  const cases = new Map(contract.files.map((file) => [file, []]));
  titles.forEach((title, index) => cases.get(contract.files[index % contract.files.length]).push(title));
  for (const [file, list] of cases) {
    fs.writeFileSync(path.join(fixtureRoot, file), `const { test, expect } = require(${JSON.stringify(playwrightTest)});\n`
      + list.map((title) => `test(${JSON.stringify(title)}, async () => { expect(true).toBe(true); });`).join("\n") + "\n");
  }
  return [1, contract.parts].map((current) => {
    const outputDir = path.join(fixtureRoot, `results-${current}`);
    const configPath = path.join(fixtureRoot, `playwright-${current}.config.mjs`);
    fs.writeFileSync(configPath, `export default ${JSON.stringify({
      testDir: fixtureRoot, testMatch: "*.spec.ts", forbidOnly: true, fullyParallel: false, workers: 1, retries: 0,
      timeout: 5_000, globalTimeout: 15_000, outputDir, reporter: [[reporterPath, { lane: "browser-ui" }]],
    }, null, 2)};\n`);
    const result = spawnSync(process.execPath, [playwrightCli, "test", "--config", configPath, `--shard=${current}/${contract.parts}`], {
      cwd: fixtureRoot, env: browserCiEnvironment(), encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, diagnostic);
    return JSON.parse(fs.readFileSync(path.join(outputDir, "required-browser-result.json"), "utf8"));
  });
}

test("each real Playwright shard of the browser UI lane records its part, and both together meet the lane", (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const receipts = runBrowserUiParts(t);
  assert.equal(contract.parts, 2);
  receipts.forEach((receipt, index) => {
    assert.equal(receipt.status, "passed");
    assert.deepEqual(receipt.part, { current: index + 1, total: 2 });
    assert.ok(receipt.selected > 0 && receipt.selected < contract.minimumTests);
  });
  assert.equal(receipts[0].selected + receipts[1].selected, contract.minimumTests);
  assert.equal(combineRequiredBrowserParts("browser-ui", receipts).status, "passed");
  for (const receipt of receipts) assert.equal(combineRequiredBrowserParts("browser-ui", [receipt]).status, "failed");
  assert.equal(combineRequiredBrowserParts("browser-ui", [receipts[0], receipts[0]]).status, "failed");
});

test("a required case missing from both real shards fails the browser UI lane though each shard passed", (t) => {
  const renamed = "keeps Unicode remote input out of a previously focused local editor";
  const receipts = runBrowserUiParts(t, { renamed });
  assert.ok(receipts.every((receipt) => receipt.status === "passed"));
  const combined = combineRequiredBrowserParts("browser-ui", receipts);
  assert.equal(combined.status, "failed");
  assert.deepEqual(combined.failures, [`Required case missing: ${renamed}`]);
});
