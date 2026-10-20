// The browser host cost measurement: the report and gates
// (scripts/runtime-browser-cost.mjs), the measuring script and the manual
// workflow that runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GATES, SECTION_END, SECTION_START, evaluate, median, percentile, renderMarkdown, replaceSection,
} from "./runtime-browser-cost.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const MIB = 1024 * 1024;

function measurements(overrides = {}) {
  return {
    schemaVersion: 1,
    beforeImage: "ghcr.io/instafy-dev/instafy-runtime-agent:aaaa-linux-amd64",
    afterImage: "ghcr.io/instafy-dev/instafy-runtime-agent:bbbb-linux-amd64",
    imageBytes: { before: 1_500_000_000, after: 1_800_000_000 },
    coldPullMs: { before: 40_000, after: 52_000 },
    bootMs: { before: [400, 380, 420, 390, 410], after: [430, 420, 440, 400, 450] },
    idleSeconds: 60,
    idleMemoryBytes: { before: 20 * MIB, after: 21 * MIB },
    hostStartMs: [9_000, ...Array.from({ length: 19 }, (_, index) => 2_000 + index * 10)],
    memoryBytes: { aboutBlank: 300 * MIB, denseTable: 520 * MIB, canvas: 600 * MIB },
    screencast: { cores: 0.85, frames: 1700, seconds: 60 },
    tmpKib: { before: 120, after: 200 },
    profileKib: 6000,
    ...overrides,
  };
}

test("percentiles use the nearest rank", () => {
  const values = Array.from({ length: 20 }, (_, index) => 20 - index);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile(values, 95), 19);
  assert.equal(percentile(values, 99), 20);
  assert.equal(percentile([7], 99), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.throws(() => percentile([], 50));
});

test("the gates are the plan's limits and fail only above them", () => {
  assert.deepEqual(GATES.map(({ key, limit }) => [key, limit]), [
    ["imageDelta", 400_000_000], ["bootDelta", 500], ["idleDelta", 16 * MIB], ["startP95", 15_000],
  ]);
  const passing = evaluate(measurements());
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.gates.map((gate) => gate.value), [300_000_000, 30, MIB, 2_180]);
  assert.deepEqual(passing.start, { first: 9_000, p50: 2_090, p95: 2_180, p99: 9_000, runs: 20 });

  const atLimits = evaluate(measurements({
    imageBytes: { before: 1, after: 400_000_001 },
    bootMs: { before: [100], after: [600] },
    idleMemoryBytes: { before: 0, after: 16 * MIB },
    hostStartMs: [15_000],
  }));
  assert.equal(atLimits.passed, true);

  for (const [overrides, key] of [
    [{ imageBytes: { before: 1, after: 400_000_002 } }, "imageDelta"],
    [{ bootMs: { before: [100], after: [601] } }, "bootDelta"],
    [{ idleMemoryBytes: { before: 0, after: 16 * MIB + 1 } }, "idleDelta"],
    [{ hostStartMs: Array.from({ length: 20 }, (_, index) => (index < 18 ? 1_000 : 15_001)) }, "startP95"],
  ]) {
    const result = evaluate(measurements(overrides));
    assert.equal(result.passed, false, key);
    assert.deepEqual(result.gates.filter((gate) => !gate.passed).map((gate) => gate.key), [key]);
  }

  assert.throws(() => evaluate({ ...measurements(), schemaVersion: 2 }), /schema/u);
  assert.throws(() => evaluate(measurements({ hostStartMs: [] })), /hostStartMs/u);
  assert.throws(() => evaluate(measurements({ idleMemoryBytes: { before: "1", after: 2 } })), /idleMemoryBytes/u);
});

test("the report shows every measurement and keeps image references inert", () => {
  const markdown = renderMarkdown(evaluate(measurements({ afterImage: "x`|y\n## injected" })), { measuredAt: "2026-10-20", hosted: true });
  assert.match(markdown, /^Measured 2026-10-20 on a GitHub-hosted runner:$/mu);
  assert.match(markdown, /after `xy## injected`\.$/mu);
  assert.doesNotMatch(markdown, /^## injected/mu);
  for (const row of [
    /^\| Image size increase \| 300\.0 MB \| 400\.0 MB \| pass \|$/mu,
    /^\| Boot time increase \(median\) \| 30 ms \| 500 ms \| pass \|$/mu,
    /^\| Idle memory increase, browser never started \| 1\.0 MiB \| 16\.0 MiB \| pass \|$/mu,
    /^\| Browser host start to CDP ready, p95 \| 2180 ms \| 15\.0 s \| pass \|$/mu,
    /^\| Cold pull \| 40\.0 s \| 52\.0 s \|$/mu,
    /^\| Start to CDP ready over 20 starts on one profile: first, p50, p95, p99 \| 9000 ms, 2090 ms, 2180 ms, 9000 ms \|$/mu,
    /^\| Container CPU during 60 s of CDP screencast \(reported, not gated\) \| 0\.85 cores, 1700 frames \|$/mu,
    /^\| `\/tmp` growth across all starts \| 80 KiB \|$/mu,
  ]) {
    assert.match(markdown, row);
  }
  assert.match(markdown, /Every gate passed\.\n$/u);
  const local = renderMarkdown(evaluate(measurements({ coldPullMs: { before: null, after: null } })), { measuredAt: "2026-10-20" });
  assert.match(local, /on a local machine, not a release measurement:/u);
  assert.match(local, /^\| Cold pull \| not measured \| not measured \|$/mu);
  const failing = renderMarkdown(evaluate(measurements({ hostStartMs: [20_000] })), { measuredAt: "2026-10-20" });
  assert.match(failing, /\| \*\*fail\*\* \|/u);
  assert.match(failing, /At least one gate failed/u);
});

test("only the marked section of the page is replaced", () => {
  const doc = `# Title\n\nintro\n\n${SECTION_START}\nold numbers\n${SECTION_END}\n\n## Next\n`;
  assert.equal(replaceSection(doc, "new numbers\n"), `# Title\n\nintro\n\n${SECTION_START}\nnew numbers\n${SECTION_END}\n\n## Next\n`);
  assert.throws(() => replaceSection("# no markers\n", "x\n"), /markers/u);
  assert.throws(() => replaceSection(`${SECTION_END}\n${SECTION_START}\n`, "x\n"), /markers/u);
  assert.throws(() => replaceSection(`${SECTION_START}\n${SECTION_START}\n${SECTION_END}\n`, "x\n"), /markers/u);

  const page = read("docs/Runtime-Image-Builds.md");
  assert.equal(page.split(SECTION_START).length, 2);
  assert.equal(page.split(SECTION_END).length, 2);
  assert.ok(page.indexOf(SECTION_START) < page.indexOf(SECTION_END));
  assert.match(page, /^## Browser host cost$/mu);
});

test("the report command writes the page copy and fails on a failed gate without touching the checkout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-browser-cost-"));
  try {
    const doc = path.join(directory, "Runtime-Image-Builds.md");
    fs.writeFileSync(doc, `# Page\n${SECTION_START}\nold\n${SECTION_END}\n`);
    const run = (values) => {
      const file = path.join(directory, "measurements.json");
      fs.writeFileSync(file, JSON.stringify(values));
      return spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/runtime-browser-cost.mjs"), file, doc, path.join(directory, "out")],
        { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: path.join(directory, "summary.md") } });
    };
    const passed = run(measurements());
    assert.equal(passed.status, 0, passed.stderr);
    const updated = fs.readFileSync(path.join(directory, "out", "Runtime-Image-Builds.md"), "utf8");
    assert.match(updated, /Every gate passed\./u);
    assert.doesNotMatch(updated, /\nold\n/u);
    assert.equal(fs.readFileSync(doc, "utf8"), `# Page\n${SECTION_START}\nold\n${SECTION_END}\n`, "the input page is unchanged");
    assert.match(fs.readFileSync(path.join(directory, "summary.md"), "utf8"), /^## Browser host cost$/mu);

    const failed = run(measurements({ idleMemoryBytes: { before: 0, after: 64 * MIB } }));
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /^::error title=Browser host cost gate failed::Idle memory increase, browser never started: 64\.0 MiB is over 16\.0 MiB$/mu);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the cost workflow is manual, hosted and has no secrets", () => {
  const workflow = read(".github/workflows/runtime-browser-cost.yml");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|schedule|workflow_run|merge_group):/mu);
  assert.match(workflow, /^permissions:\n  contents: read\n\n/mu);
  assert.match(workflow, /^    runs-on: ubuntu-24\.04$/mu);
  assert.doesNotMatch(workflow, /secrets\.|self-hosted|docker login|docker push|environment:/u);
  assert.match(workflow, /persist-credentials: false/u);
  for (const action of workflow.matchAll(/^\s+uses: (\S+)/gmu)) assert.match(action[1], /@[0-9a-f]{40}$/u);
  // Inputs reach shell only through the environment, after a strict check.
  const runBlocks = workflow.split(/\n(?=      - name: )/u).slice(1)
    .filter((step) => step.includes("\n        run: ")).map((step) => step.slice(step.indexOf("\n        run: ")));
  assert.equal(runBlocks.length, 3);
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/u);
  assert.ok(workflow.indexOf("- name: Require two runtime image references") < workflow.indexOf("- name: Measure\n"));
  assert.match(workflow, /pattern='\^ghcr\\\.io\/instafy-dev\/instafy-runtime-agent\(:\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,127\}\|@sha256:\[0-9a-f\]\{64\}\)\$'/u);
  assert.match(workflow, /run: bash scripts\/runtime-browser-cost\.sh "\$BEFORE_IMAGE" "\$AFTER_IMAGE"/u);
});

test("the cost script measures with the browser off at boot and cleans up its containers", () => {
  const script = read("scripts/runtime-browser-cost.sh");
  assert.ok(fs.statSync(path.join(repositoryRoot, "scripts/runtime-browser-cost.sh")).mode & 0o111);
  const syntax = spawnSync("bash", ["-n", path.join(repositoryRoot, "scripts/runtime-browser-cost.sh")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /^trap cleanup EXIT$/mu);
  assert.match(script, /containers\+=\("\$container"\)\n {4}runs\+=\("\$\(boot_container /u);
  assert.doesNotMatch(script, /INSTAFY_ENABLE_BROWSER_SESSION=1|docker login|docker push|ICE_SERVERS_JSON/u);
  assert.match(script, /The after image runs browser processes at boot/u);
  assert.match(script, /bash \/usr\/local\/bin\/runtime-entrypoint start-browser-host/u);
  assert.match(script, /node "\$repository_root\/scripts\/runtime-browser-cost\.mjs" "\$measurements"/u);
  // data: URL fixtures cannot hold "%" or "#".
  for (const fixture of script.matchAll(/^(?:table|canvas)_page='(data:[^']*)'$/gmu)) {
    assert.doesNotMatch(fixture[1], /[%#]/u);
  }
});
