import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import RequiredBrowserReporter, { REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";

function setup(t, lane = "personal") {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-reporter-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const reporter = new RequiredBrowserReporter({ lane });
  const tests = REQUIRED_BROWSER_LANES.personal.titles.map((title, index) => ({
    id: `case-${index}`,
    title,
    location: { file: "/fixture/electron-personal-browser.spec.ts" },
    expectedStatus: "passed",
  }));
  return { reporter, tests, outputDir,
    begin(selected = tests) { reporter.onBegin({ projects: [{ outputDir }] }, { allTests: () => selected }); },
    pass(selected = tests) { for (const item of selected) reporter.onTestEnd(item, { status: "passed", retry: 0 }); },
  };
}

function browserUiInventory(run) {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  return Array.from({ length: contract.minimumTests }, (_, index) => ({
    ...run.tests[0],
    id: String(index),
    title: contract.titles[index] ?? `other browser UI case ${index}`,
    location: { file: `/fixture/${contract.files[index % contract.files.length]}` },
  }));
}

test("accepts actual first-attempt passes and writes a bounded receipt", async (t) => {
  const run = setup(t); run.begin(); run.pass();
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "passed" });
  const receipt = JSON.parse(fs.readFileSync(path.join(run.outputDir, "required-browser-result.json"), "utf8"));
  assert.equal(receipt.passed, 4); assert.equal(receipt.skipped, 0);
  assert.ok(receipt.tests.every((item) => !item.file.includes("/")));
});

test("rejects a zero-test or filtered-out required case even if runner exits successfully", async (t) => {
  for (const count of [0, 3]) {
    const run = setup(t); const selected = run.tests.slice(0, count);
    run.begin(selected); run.pass(selected);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
  }
});

test("minimum count does not hide a replaced cookie proof", async (t) => {
  const run = setup(t); run.tests[2].title = "unrelated passing test";
  run.begin(); run.pass();
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("rejects skipped, expected-failure, unexecuted and retry/flaky cases", async (t) => {
  for (const scenario of ["skipped", "expected-failure", "not-run", "retry", "flaky"]) {
    const run = setup(t); run.begin(); run.pass(run.tests.slice(1));
    const item = run.tests[0];
    if (scenario === "skipped") {
      item.expectedStatus = "skipped"; run.reporter.onTestEnd(item, { status: "skipped", retry: 0 });
    } else if (scenario === "expected-failure") {
      item.expectedStatus = "failed"; run.reporter.onTestEnd(item, { status: "failed", retry: 0 });
    } else if (scenario === "retry") {
      run.reporter.onTestEnd(item, { status: "passed", retry: 1 });
    } else if (scenario === "flaky") {
      run.reporter.onTestEnd(item, { status: "failed", retry: 0 });
      run.reporter.onTestEnd(item, { status: "passed", retry: 1 });
    }
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, scenario);
  }
});

test("global failures, unknown lanes and missing discovery fail closed", async (t) => {
  const run = setup(t); run.begin(); run.pass(); run.reporter.onError(new Error("not copied"));
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
  for (const lane of ["wrong-lane", "constructor", "toString", "__proto__"]) {
    const unknown = setup(t, lane); unknown.begin(); unknown.pass();
    assert.deepEqual(await unknown.reporter.onEnd({ status: "passed" }), { status: "failed" });
  }
  const absent = new RequiredBrowserReporter({ lane: "personal" });
  assert.deepEqual(await absent.onEnd({ status: "passed" }), { status: "failed" });
});

test("missing component spec fails despite enough other tests", async (t) => {
  const run = setup(t, "browser-ui");
  const tests = Array.from({ length: REQUIRED_BROWSER_LANES["browser-ui"].minimumTests }, (_, index) => ({ ...run.tests[0], id: String(index) }));
  run.begin(tests); run.pass(tests);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("Shared Studio requires the complete named journey without skipping or retries", async (t) => {
  for (const scenario of ["pass", "missing", "renamed", "skipped", "retry"]) {
    const run = setup(t, "shared-studio");
    const contract = REQUIRED_BROWSER_LANES["shared-studio"];
    const item = { ...run.tests[0], title: contract.titles[0],
      location: { file: `/fixture/${contract.files[0]}` } };
    if (scenario === "renamed") item.title = "an unrelated smoke test";
    if (scenario === "skipped") item.expectedStatus = "skipped";
    run.begin(scenario === "missing" ? [] : [item]);
    if (scenario !== "missing") run.reporter.onTestEnd(item,
      { status: scenario === "skipped" ? "skipped" : "passed", retry: scenario === "retry" ? 1 : 0 });
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }),
      { status: scenario === "pass" ? "passed" : "failed" }, scenario);
  }
});

test("browser UI lane requires the mobile sidebar geometry regression", async (t) => {
  const run = setup(t, "browser-ui");
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  assert.ok(contract.files.includes("mobile-sidebar-safe-area.spec.ts"));
  const tests = browserUiInventory(run);
  run.begin(tests); run.pass(tests);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "passed" });
  const missing = tests.map((item) => item.location.file.endsWith("mobile-sidebar-safe-area.spec.ts")
    ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item);
  run.begin(missing);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("minimum count cannot hide a replaced Shared full-modal safe-area case", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  assert.ok(contract.files.includes("shared-browser-expanded-safe-area.spec.ts"));
  assert.equal(contract.titles.length, 6);
  for (const requiredTitle of contract.titles) {
    const run = setup(t, "browser-ui");
    const tests = browserUiInventory(run).map((item) => item.title === requiredTitle
      ? { ...item, title: "unrelated passing geometry test" } : item);
    run.begin(tests); run.pass(tests);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, requiredTitle);
  }
});

test("receipt write errors cannot be swallowed into a green Playwright result", async (t) => {
  const run = setup(t); run.begin(); run.pass();
  const notADirectory = path.join(run.outputDir, "file"); fs.writeFileSync(notADirectory, "fixture");
  run.reporter.config.projects[0].outputDir = notADirectory;
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});
