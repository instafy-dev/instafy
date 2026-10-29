import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import RequiredBrowserReporter, { combineRequiredBrowserParts, REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";
import { checkRequiredBrowserParts, readPartReceipts } from "../packages/frontend/scripts/required-browser-parts.mjs";

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
  assert.equal(receipt.passed, REQUIRED_BROWSER_LANES.personal.titles.length); assert.equal(receipt.skipped, 0);
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

test("Personal lane fails when its real-Chromium request-guard proof is filtered out", async (t) => {
  const guardProof = "stops agent-driven page loads on a link-only site or a private address, also by the address actually connected to";
  const run = setup(t); const others = run.tests.filter((item) => item.title !== guardProof);
  run.begin(others); run.pass(others);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("Personal lane fails when its real-Chromium form-submission proof is filtered out", async (t) => {
  const formProof = "judges and takes form steps by the submission the browser makes, the default button's formaction, formmethod and formtarget included";
  assert.ok(REQUIRED_BROWSER_LANES.personal.titles.includes(formProof));
  const run = setup(t); const others = run.tests.filter((item) => item.title !== formProof);
  run.begin(others); run.pass(others);
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
  assert.equal(contract.minimumTests, 53);
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
  assert.equal(contract.minimumTests, 53);
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
  assert.equal(contract.minimumTests, 53);
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

test("browser UI cannot omit a thread-spine surface theme or viewport", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const file = "thread-spine-surface.spec.ts";
  const titles = ["light", "dark"].flatMap((theme) => [390, 1280].map((width) =>
    `thread spine notches erase to the surface behind them in ${theme} at ${width}px`));
  assert.ok(contract.files.includes(file));
  for (const title of titles) assert.ok(contract.titles.includes(title), title);
  for (const target of [file, ...titles]) {
    const run = setup(t, "browser-ui");
    const selected = browserUiInventory(run).map((item) => item.title === target
      ? { ...item, title: "unrelated passing spine case" }
      : target === file && item.location.file.endsWith(file)
        ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item);
    run.begin(selected); run.pass(selected);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, target);
  }
});

// A lane CI runs in parts: each part proves its own tests, and the required
// check proves the lane's contract on every part's receipt together.
async function runPart(t, lane, selected, part) {
  const run = setup(t, lane);
  run.reporter.onBegin({ projects: [{ outputDir: run.outputDir }], shard: part }, { allTests: () => selected });
  run.pass(selected);
  const result = await run.reporter.onEnd({ status: "passed" });
  return { result, receipt: JSON.parse(fs.readFileSync(path.join(run.outputDir, "required-browser-result.json"), "utf8")) };
}

async function browserUiParts(t, mutate = (tests) => tests) {
  const run = setup(t, "browser-ui");
  const tests = mutate(browserUiInventory(run));
  const half = Math.ceil(tests.length / 2);
  return [await runPart(t, "browser-ui", tests.slice(0, half), { current: 1, total: 2 }),
    await runPart(t, "browser-ui", tests.slice(half), { current: 2, total: 2 })];
}

test("a part of the browser UI lane passes on its own tests and records which part it is", async (t) => {
  assert.equal(REQUIRED_BROWSER_LANES["browser-ui"].parts, 2);
  const [first, second] = await browserUiParts(t);
  for (const [index, part] of [first, second].entries()) {
    assert.deepEqual(part.result, { status: "passed" });
    assert.deepEqual(part.receipt.part, { current: index + 1, total: 2 });
    assert.ok(part.receipt.tests.every((item) => typeof item.id === "string"));
  }
  // Neither half alone meets the lane's contract; only both together do.
  const run = setup(t, "browser-ui"); const half = browserUiInventory(run).slice(0, 27);
  run.begin(half); run.pass(half);
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("an empty part, a part of an unsplit lane, a wrong part count or a retried case fails the part", async (t) => {
  assert.deepEqual((await runPart(t, "browser-ui", [], { current: 2, total: 2 })).result, { status: "failed" });
  const personal = setup(t).tests;
  assert.deepEqual((await runPart(t, "personal", personal, { current: 1, total: 2 })).result, { status: "failed" });
  const inventory = browserUiInventory(setup(t, "browser-ui"));
  assert.deepEqual((await runPart(t, "browser-ui", inventory, { current: 1, total: 1 })).result, { status: "failed" });
  assert.deepEqual((await runPart(t, "browser-ui", inventory.slice(0, 5), { current: 1, total: 3 })).result, { status: "failed" });
  const run = setup(t, "browser-ui"); const selected = inventory.slice(0, 5);
  run.reporter.onBegin({ projects: [{ outputDir: run.outputDir }], shard: { current: 1, total: 2 } }, { allTests: () => selected });
  run.pass(selected.slice(1));
  run.reporter.onTestEnd(selected[0], { status: "failed", retry: 0 });
  run.reporter.onTestEnd(selected[0], { status: "passed", retry: 1 });
  assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" });
});

test("both passing parts together meet the browser UI contract", async (t) => {
  const receipts = (await browserUiParts(t)).map((part) => part.receipt);
  const combined = combineRequiredBrowserParts("browser-ui", receipts);
  assert.deepEqual(combined, { lane: "browser-ui", status: "passed", parts: 2, selected: REQUIRED_BROWSER_LANES["browser-ui"].minimumTests, failures: [] });
  assert.equal(combineRequiredBrowserParts("browser-ui", [...receipts].reverse()).status, "passed");
});

test("a missing, repeated, failed or foreign part, or a case run twice, never makes the lane pass", async (t) => {
  const [first, second] = (await browserUiParts(t)).map((part) => part.receipt);
  const failed = (receipts) => combineRequiredBrowserParts("browser-ui", receipts);
  const without = (receipt, key) => { const copy = structuredClone(receipt); delete copy[key]; return copy; };
  const changed = (receipt, change) => { const copy = structuredClone(receipt); change(copy); return copy; };
  for (const receipts of [
    [], [first], [second], [first, first], [first, second, second],
    [first, changed(second, (copy) => { copy.part.current = 1; })],
    [first, changed(second, (copy) => { copy.part.total = 3; })],
    [first, changed(second, (copy) => { copy.part.current = 3; copy.part.total = 3; })],
    [first, without(second, "part")],
    [first, changed(second, (copy) => { copy.status = "failed"; })],
    [first, changed(second, (copy) => { copy.failures = ["Runner status: timedout"]; })],
    [first, changed(second, (copy) => { copy.tests[0].passed = false; })],
    [first, changed(second, (copy) => { copy.tests = []; })],
    [first, changed(second, (copy) => { copy.tests[0].id = first.tests[0].id; })],
    [first, changed(second, (copy) => { copy.lane = "personal"; })],
    [first, changed(second, (copy) => { copy.schemaVersion = 2; })],
    [first, null], [first, []], [first, "passed"], [first, changed(second, (copy) => { copy.tests = [null]; })],
  ]) assert.equal(failed(receipts).status, "failed", JSON.stringify(receipts.map((receipt) => receipt?.part ?? receipt)));
  for (const lane of ["personal", "shared-studio", "unknown", "constructor", "__proto__"]) {
    assert.equal(combineRequiredBrowserParts(lane, [first, second]).status, "failed", lane);
  }
  assert.equal(combineRequiredBrowserParts("browser-ui", null).status, "failed");
});

test("a required case or spec missing from every part fails the lane even when both parts passed", async (t) => {
  const requiredTitle = "Escape returns from the mobile workspace drill-in before dismissing navigation";
  const renamed = (await browserUiParts(t, (tests) => tests.map((item) => item.title === requiredTitle
    ? { ...item, title: "unrelated passing dismissal test" } : item))).map((part) => part.receipt);
  assert.ok(renamed.every((receipt) => receipt.status === "passed"));
  const combined = combineRequiredBrowserParts("browser-ui", renamed);
  assert.equal(combined.status, "failed");
  assert.ok(combined.failures.includes(`Required case missing: ${requiredTitle}`));
  const requiredFile = "mobile-sidebar-safe-area.spec.ts";
  const moved = (await browserUiParts(t, (tests) => tests.map((item) => item.location.file.endsWith(requiredFile)
    ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item))).map((part) => part.receipt);
  assert.ok(combineRequiredBrowserParts("browser-ui", moved).failures.includes(`Required spec missing: ${requiredFile}`));
  const short = (await browserUiParts(t, (tests) => tests.slice(0, -1))).map((part) => part.receipt);
  assert.equal(short.length, 2);
  assert.ok(short.every((receipt) => receipt.status === "passed"));
  const shortCount = short.reduce((count, receipt) => count + receipt.tests.length, 0);
  assert.equal(shortCount, REQUIRED_BROWSER_LANES["browser-ui"].minimumTests - 1);
  const incomplete = combineRequiredBrowserParts("browser-ui", short);
  assert.equal(incomplete.selected, shortCount);
  assert.equal(incomplete.status, "failed");
  assert.ok(incomplete.failures.includes("Required tests are missing"));
});

test("the required check reads every part's receipt from the downloaded artifacts and fails closed", async (t) => {
  const receipts = (await browserUiParts(t)).map((part) => part.receipt);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-parts-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  // Download layout: one folder per artifact; the first part also keeps the
  // co-browsing fixture's results beside its own.
  const write = (relative, receipt) => {
    fs.mkdirSync(path.dirname(path.join(folder, relative)), { recursive: true });
    fs.writeFileSync(path.join(folder, relative), `${JSON.stringify(receipt)}\n`);
  };
  write("browser-ui-rendering-1/browser-ui/required-browser-result.json", receipts[0]);
  write("browser-ui-rendering-1/shared-cobrowsing/result.json", { status: "passed" });
  assert.equal(readPartReceipts(folder).length, 1);
  const output = [];
  const stream = { write: (text) => output.push(text) };
  const quiet = (args) => checkRequiredBrowserParts(args, { stdout: stream, stderr: stream });
  assert.equal(quiet(["browser-ui", folder]), 1);
  assert.ok(output.includes("[required-browser] Part 2 of 2 is missing\n"));
  write("browser-ui-rendering-2/required-browser-result.json", receipts[1]);
  assert.equal(quiet(["browser-ui", folder]), 0);
  assert.equal(output.at(-1), `[required-browser] browser-ui: ${REQUIRED_BROWSER_LANES["browser-ui"].minimumTests} tests passed in 2 parts; passed\n`);
  // A linked folder is not followed, so a receipt cannot be counted twice.
  fs.symlinkSync(path.join(folder, "browser-ui-rendering-2"), path.join(folder, "linked"));
  assert.equal(readPartReceipts(folder).length, 2);
  assert.equal(quiet(["browser-ui", folder]), 0);
  write("browser-ui-rendering-3/required-browser-result.json", receipts[1]);
  assert.equal(quiet(["browser-ui", folder]), 1);
  fs.writeFileSync(path.join(folder, "browser-ui-rendering-3/required-browser-result.json"), "not json");
  assert.throws(() => quiet(["browser-ui", folder]));
  for (const args of [[], ["browser-ui"], ["browser-ui", folder, "extra"]]) assert.throws(() => quiet(args), /Usage:/u);
});

test("browser UI requires login and global-search keyboard regressions", async (t) => {
  const contract = REQUIRED_BROWSER_LANES["browser-ui"];
  const files = ["login-keyboard.spec.ts", "search-keyboard.spec.ts"];
  const titles = [
    "preserves email and focus, and leaves long errors reachable through document scrolling",
    "keeps login actions clear of system bars and respects rotated side insets",
    "keeps the first actual result visible with query and scope controls",
    "keeps loading, error recovery and empty results reachable within native safe areas",
  ];
  for (const file of files) assert.ok(contract.files.includes(file), file);
  for (const title of titles) assert.ok(contract.titles.includes(title), title);
  for (const target of [...files, ...titles]) {
    const run = setup(t, "browser-ui");
    const selected = browserUiInventory(run).map(item => item.title === target
      ? { ...item, title: "unrelated passing keyboard case" }
      : files.includes(target) && item.location.file.endsWith(target)
        ? { ...item, location: { file: "/fixture/browser-live-proof.spec.ts" } } : item);
    run.begin(selected); run.pass(selected);
    assert.deepEqual(await run.reporter.onEnd({ status: "passed" }), { status: "failed" }, target);
  }
});
