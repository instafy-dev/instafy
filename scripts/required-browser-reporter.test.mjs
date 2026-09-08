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

test("minimum count cannot hide the mobile workspace Escape dismissal regression", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const requiredTitle = "Escape returns from the mobile workspace drill-in before dismissing navigation";
  assert.equal(contract.minimumTests, 39);
  assert.ok(contract.titles.includes(requiredTitle));
  const run = setup(t, "browser-ui");
  const tests = browserUiInventory(run).map((item) => item.title === requiredTitle
    ? { ...item, title: "unrelated passing dismissal test" } : item);
  run.begin(tests); run.pass(tests);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("minimum count cannot hide a replaced Shared full-modal safe-area case", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  assert.ok(contract.files.includes("shared-browser-expanded-safe-area.spec.ts"));
  const safeAreaTitles = contract.titles.filter((title) => title.startsWith("expanded Shared "));
  assert.equal(safeAreaTitles.length, 6);
  for (const requiredTitle of safeAreaTitles) {
    const run = setup(t, "browser-ui");
    const tests = browserUiInventory(run).map((item) => item.title === requiredTitle
      ? { ...item, title: "unrelated passing geometry test" } : item);
    run.begin(tests); run.pass(tests);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, requiredTitle);
  }
});

test("browser UI requires both portrait and short-landscape session/status cases", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  assert.equal(contract.minimumTests, 39);
  assert.ok(contract.files.includes("shared-browser-sessions-responsive.spec.ts"));
  const sessionTitles = contract.titles.filter((title) => title.startsWith("Shared sessions and saved status "));
  assert.deepEqual(sessionTitles, [
    "Shared sessions and saved status stay usable in portrait",
    "Shared sessions and saved status stay usable in short landscape",
  ]);
  for (const requiredTitle of sessionTitles) {
    const run = setup(t, "browser-ui");
    const tests = browserUiInventory(run).map((item) => item.title === requiredTitle
      ? { ...item, title: "unrelated passing session test" } : item);
    run.begin(tests); run.pass(tests);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, requiredTitle);
  }
});

test("browser UI cannot omit the retained-editor Unicode input regression", async (t) => {
  const requiredTitle = "keeps Unicode remote input out of a previously focused local editor";
  assert.ok(REQUIRED_BROWSER_LANES["browser-ui"].titles.includes(requiredTitle));
  const run = setup(t, "browser-ui");
  const tests = browserUiInventory(run).map((item) => item.title === requiredTitle
    ? { ...item, title: "unrelated passing keyboard test" } : item);
  run.begin(tests); run.pass(tests);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("browser UI cannot omit the focused-editable reveal regression", async (t) => {
  const requiredTitle = "reveals only a clipped focused editable without changing focus or values";
  const requiredFile = "shared-browser-focused-editable.spec.ts";
  assert.ok(REQUIRED_BROWSER_LANES["browser-ui"].titles.includes(requiredTitle));
  assert.ok(REQUIRED_BROWSER_LANES["browser-ui"].files.includes(requiredFile));
  for (const replace of ["file", "title"]) {
    const run = setup(t, "browser-ui");
    const tests = browserUiInventory(run).map((item) => replace === "title" && item.title === requiredTitle
      ? { ...item, title: "unrelated passing focus test" }
      : replace === "file" && item.location.file.endsWith(requiredFile)
        ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item);
    run.begin(tests); run.pass(tests);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
  }
});

test("browser UI cannot omit the focused sidebar keyboard geometry regression", async (t) => {
  const requiredTitle = "keeps focused sidebar search centered through visual keyboard resize and restores the drawer";
  const requiredFile = "mobile-sidebar-keyboard.spec.ts";
  assert.ok(REQUIRED_BROWSER_LANES["browser-ui"].titles.includes(requiredTitle));
  assert.ok(REQUIRED_BROWSER_LANES["browser-ui"].files.includes(requiredFile));
  for (const replace of ["file", "title"]) {
    const run = setup(t, "browser-ui");
    const tests = browserUiInventory(run).map((item) => replace === "title" && item.title === requiredTitle
      ? { ...item, title: "unrelated passing sidebar test" }
      : replace === "file" && item.location.file.endsWith(requiredFile)
        ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item);
    run.begin(tests); run.pass(tests);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
  }
});

test("receipt write errors cannot be swallowed into a green Playwright result", async (t) => {
  const run = setup(t); run.begin(); run.pass();
  const notADirectory = path.join(run.outputDir, "file"); fs.writeFileSync(notADirectory, "fixture");
  run.reporter.config.projects[0].outputDir = notADirectory;
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("browser UI cannot omit a thumb navigation viewport or replace its spec", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const file = "mobile-thumb-navigation.spec.ts";
  const titles = [375, 390, 844].map((width) => `thumb navigation preserves history, selection and input at ${width}px`);
  assert.equal(contract.minimumTests, 39);
  assert.ok(contract.files.includes(file));
  for (const title of titles) assert.ok(contract.titles.includes(title));
  for (const target of [file, ...titles]) {
    const run = setup(t, "browser-ui");
    const selected = browserUiInventory(run).map((item) => item.title === target
      ? { ...item, title: "unrelated passing navigation case" }
      : target === file && item.location.file.endsWith(file)
        ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item);
    run.begin(selected); run.pass(selected);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, target);
  }
});

test("browser UI requires every Studio navigation, scroll and cross-space race proof", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const titles = [
    "restores exact visits and transcript positions through Back and Forward at 1280px",
    "restores exact visits and transcript positions through Back and Forward at 390px",
    "collapses mobile sidebar drill-ins before navigating without stale Back loops",
    "preserves rapid destinations, legacy tab clicks, jobs and unloaded deep links",
    "abandons pending old-space conversations while a new space is loading",
    "restores URL-driven settings categories and per-visit scroll with browser Back and Forward",
    "native history controls traverse Router entries with 44px targets and bounded forward state",
  ];
  for (const requiredTitle of titles) {
    assert.ok(contract.titles.includes(requiredTitle), requiredTitle);
    const run = setup(t, "browser-ui");
    const selected = browserUiInventory(run).map((item) => item.title === requiredTitle
      ? { ...item, title: "unrelated passing navigation test" } : item);
    run.begin(selected); run.pass(selected);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, requiredTitle);
  }
});
