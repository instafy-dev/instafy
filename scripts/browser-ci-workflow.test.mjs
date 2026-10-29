import { withoutManualCiRouting } from "./lib/manualCiRoutingTestBaseline.mjs";
import { BROWSER_UI_PARTS, browserUiAggregateJob, browserUiPartJob, withoutBrowserUiJobBudget, withoutBrowserUiParts } from "./lib/browserUiBudgetTestBaseline.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => withoutManualCiRouting(path.basename(relative), fs.readFileSync(path.join(root, relative), "utf8"));

const browserTools = ["bash", "git", "curl", "tar", "unzip", "sudo", "apt-get", "xvfb-run", "Xvfb", "xauth"];
// Browser UI rendering is the required check; it aggregates the lane's parts.
const routedJobs = [
  { key: "personal", label: "public-browser-personal", name: "Personal Browser E2E", minutes: 30, tools: browserTools, conditions: 3 },
  { key: "browser-ui", label: "public-browser-ui", name: "Browser UI rendering", minutes: 5, tools: ["bash", "git"], conditions: 1 },
  ...Array.from({ length: BROWSER_UI_PARTS }, (_, index) => ({ key: `browser-ui-${index + 1}`, label: `public-browser-ui-${index + 1}`,
    name: `Browser UI rendering (${index + 1} of ${BROWSER_UI_PARTS})`, minutes: 40, tools: browserTools, conditions: 2 })),
];
const partKeys = routedJobs.filter(job => /^browser-ui-\d+$/u.test(job.key)).map(job => job.key);
const jobSource = key => read(".github/workflows/browser-e2e.yml").split(`\n  ${key}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];
function callerContext(event = "pull_request") {
  const ref = event === "pull_request" ? "refs/pull/11/merge" : "refs/heads/main";
  return { repository: "instafy-dev/instafy", repository_id: "1001", run_id: "2002", run_attempt: "3",
    ref, workflow_ref: `instafy-dev/instafy/.github/workflows/build.yml@${ref}`,
    event_name: event, ref_protected: event === "push",
    event: { repository: { private: true }, ...(event === "pull_request" ? { pull_request: {
      number: 11, base: { ref: "main", repo: { full_name: "instafy-dev/instafy" } },
      head: { repo: { full_name: "instafy-dev/instafy", fork: false } },
    } } : {}) } };
}
function selectBrowser(job, github, toggle = "true") {
  const expression = jobSource(job.key).match(/^    runs-on: >-\n((?:      .*\n)+)/mu)?.[1]
    .trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  assert.ok(expression);
  assert.doesNotMatch(expression, /github\.job\b|inputs\.|matrix\./u);
  return JSON.parse(JSON.stringify(vm.runInNewContext(expression, { github,
    vars: { CI_BROWSER_SELF_HOSTED: toggle, CI_BOOTSTRAP_SELF_HOSTED: "true", CI_EXPANDED_SELF_HOSTED: "true", CI_JAVASCRIPT_SELF_HOSTED: "true" },
    fromJSON: JSON.parse,
    format: (template, ...values) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === "{{" ? "{" : match === "}}" ? "}" : String(values[index])),
  }, { timeout: 1000 })));
}

test("browser routing is independently default-off and preserves the exact job names and budgets", () => {
  for (const job of routedJobs) for (const event of ["pull_request", "push"]) {
    for (const flag of ["", "false", "0", "unknown"]) assert.equal(selectBrowser(job, callerContext(event), flag), "ubuntu-24.04");
    assert.ok(jobSource(job.key).includes(`    name: ${job.name}\n`));
    assert.ok(jobSource(job.key).includes(`    timeout-minutes: ${job.minutes}\n`));
  }
  const shared = jobSource("shared-profile");
  assert.match(shared, /vars\.CI_SHARED_BROWSER_SELF_HOSTED/u);
  assert.match(shared, /^    timeout-minutes: 5$/mu);
  assert.doesNotMatch(shared, /vars\.CI_BROWSER_SELF_HOSTED/u);
  assert.equal((read(".github/workflows/browser-e2e.yml").match(/vars\.CI_BROWSER_SELF_HOSTED/g) ?? []).length, routedJobs.length);
});

test("browser labels bind each literal job, repository, run, attempt and caller trust", () => {
  for (const job of routedJobs) for (const event of ["pull_request", "push"]) {
    const github = callerContext(event), trust = event === "push" ? "main" : "pr";
    const runner = selectBrowser(job, github);
    assert.deepEqual(runner, { group: `org/instafy-ci-${trust}`,
      labels: ["self-hosted", "Linux", "ARM64", `instafy-ci-bootstrap-1001-2002-3-${job.label}`, `instafy-ci-trust-${trust}`] });
    for (const field of ["repository_id", "run_id", "run_attempt"]) {
      const other = structuredClone(github); other[field] = "9009";
      assert.notEqual(selectBrowser(job, other).labels[3], runner.labels[3]);
    }
  }
});

test("public, fork, manual, alternate caller and stale-shaped browser routing stay hosted", () => {
  for (const job of routedJobs) {
    for (const event of ["workflow_dispatch", "workflow_call", "pull_request_target", "schedule", "workflow_run"]) {
      assert.equal(selectBrowser(job, callerContext(event)), "ubuntu-24.04");
    }
    for (const event of ["pull_request", "push"]) for (const mutate of [
      g => { g.event.repository.private = false; }, g => { g.repository = "someone/instafy"; },
      g => { delete g.workflow_ref; }, g => { g.workflow_ref = `instafy-dev/instafy/.github/workflows/browser-e2e.yml@${g.ref}`; },
      g => { g.workflow_ref = `instafy-dev/instafy/.github/workflows/other.yml@${g.ref}`; },
      g => { g.workflow_ref = "instafy-dev/instafy/.github/workflows/build.yml@refs/heads/other"; },
    ]) { const g = callerContext(event); mutate(g); assert.equal(selectBrowser(job, g), "ubuntu-24.04"); }
    for (const mutate of [
      g => { g.event.pull_request.base.ref = "other"; },
      g => { g.event.pull_request.base.repo.full_name = "someone/instafy"; },
      g => { g.event.pull_request.head.repo.full_name = "someone/instafy"; },
      g => { g.event.pull_request.head.repo.fork = true; },
      g => { g.event.pull_request.number = 12; },
      g => { g.ref = "refs/heads/main"; g.workflow_ref = `instafy-dev/instafy/.github/workflows/build.yml@${g.ref}`; },
    ]) { const g = callerContext(); mutate(g); assert.equal(selectBrowser(job, g), "ubuntu-24.04"); }
    for (const mutate of [g => { g.ref_protected = false; }, g => { g.ref = "refs/heads/other"; g.workflow_ref = `instafy-dev/instafy/.github/workflows/build.yml@${g.ref}`; }]) {
      const g = callerContext("push"); mutate(g); assert.equal(selectBrowser(job, g), "ubuntu-24.04");
    }
  }
});

function qualifyBrowser(job, mutate = () => {}, missingTool) {
  const source = jobSource(job.key);
  assert.match(source, /    steps:\n      - name: Qualify isolated browser CI runner\n        if: runner.environment == 'self-hosted'\n        shell: bash\n        run: \|/u);
  const program = source.match(/          node <<'NODE'\n([\s\S]*?)          NODE\n/u);
  assert.ok(program && source.indexOf(program[0]) < source.indexOf("uses: actions/checkout@"));
  const state = { platform: "linux", arch: "arm64", getuid: () => 503, versions: { node: "22.23.2" },
    env: { RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64", INSTAFY_CI_JOB_ISOLATION: "ephemeral" } };
  mutate(state); const observed = [];
  vm.runInNewContext(program[1].replace(/^          /gmu, ""), { process: state, require(name) {
    if (name === "node:assert/strict") return assert;
    assert.equal(name, "node:child_process");
    return { execFileSync(file, args, options) {
      assert.equal(file, "/bin/bash"); assert.equal(args[1], 'command -v "$1" >/dev/null');
      assert.equal(options.timeout, 1000); assert.equal(options.stdio, "ignore");
      observed.push(args[3]); if (args[3] === missingTool) throw Error("missing prerequisite");
    } };
  } }, { timeout: 1000 });
  return observed;
}

test("browser qualification fails before checkout for wrong isolation, platform, Node or missing baseline tools", () => {
  for (const job of routedJobs) {
    const tools = qualifyBrowser(job);
    assert.deepEqual(tools, job.tools);
    for (const tool of tools) assert.throws(() => qualifyBrowser(job, () => {}, tool));
    for (const mutate of [s => { s.platform = "darwin"; }, s => { s.arch = "x64"; }, s => { s.getuid = () => 0; },
      s => { s.versions.node = "20.20.2"; }, s => { s.env.RUNNER_OS = "macOS"; }, s => { s.env.RUNNER_ARCH = "X64"; },
      s => { delete s.env.INSTAFY_CI_JOB_ISOLATION; }, s => { s.env.INSTAFY_ENV_DIR = "/inert-private-env"; }]) {
      assert.throws(() => qualifyBrowser(job, mutate));
    }
    assert.equal((jobSource(job.key).match(/^        if: /gmu) ?? []).length, job.conditions,
      "only qualification, Personal native dependency setup and always-upload may be conditional");
  }
});

test("only the self-hosted Personal job installs its documented GTK3 dependency before the native fixture build", () => {
  const personal = jobSource("personal");
  const step = "      - name: Install Linux Electron runtime dependency\n        if: runner.environment == 'self-hosted'\n        run: sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libgtk-3-0t64\n";
  assert.ok(personal.includes(step));
  assert.ok(personal.indexOf(step) > personal.indexOf("playwright install --with-deps chromium"));
  assert.ok(personal.indexOf(step) < personal.indexOf("pnpm --filter @instafy/desktop-runtime-agent build"));
  for (const key of ["browser-ui", ...partKeys, "shared-profile"]) assert.doesNotMatch(jobSource(key), /libgtk-3-0t64|Install Linux Electron runtime dependency/u);
  assert.match(personal, /xvfb-run -a pnpm test:browser:ci personal/u);
  assert.doesNotMatch(personal, /--no-sandbox|--allow-unauthenticated|--ignore-scripts|NODE_TLS_REJECT_UNAUTHORIZED/u);
});

test("Personal CI installs its locked Electron binary before the scrubbed test process", () => {
  const personal = jobSource("personal");
  const install = "      - name: Install the locked Electron binary\n        timeout-minutes: 5\n        env:\n          NODE_USE_ENV_PROXY: \"1\"\n        run: pnpm --filter @instafy/desktop-app exec install-electron\n";
  assert.ok(personal.includes(install));
  assert.ok(personal.indexOf(install) > personal.indexOf("run: pnpm install --frozen-lockfile"));
  assert.ok(personal.indexOf(install) < personal.indexOf("Run real Personal Browser cookie and ownership E2E"));
  assert.equal((read(".github/workflows/browser-e2e.yml").match(/exec install-electron/g) ?? []).length, 1);
  assert.doesNotMatch(personal, /npx|pnpm dlx|electron@latest|ELECTRON_OVERRIDE_DIST_PATH|electron_use_remote_checksums|NODE_TLS_REJECT_UNAUTHORIZED/u);
  const runner = read("packages/frontend/scripts/browser-ci.mjs");
  assert.doesNotMatch(runner, /NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ELECTRON_GET_USE_PROXY/u,
    "download proxy support must not enter either scrubbed test environment");
});

test("Public Build includes browser verification in its existing release result", () => {
  const build = read(".github/workflows/build.yml");
  assert.match(build, /\n  pull_request:/);
  assert.match(build, /\n  push:\n    branches:\n      - main/);
  assert.match(build, /\n  browser-verification:\n    name: Browser verification\n    uses: \.\/\.github\/workflows\/browser-e2e\.yml\n    permissions:\n      contents: read/);
});

test("required browser lanes execute without secret or production authority", () => {
  const workflow = read(".github/workflows/browser-e2e.yml");
  assert.match(workflow, /\n  workflow_call:/);
  assert.doesNotMatch(workflow, /secrets:|secrets\.|continue-on-error:|pull_request_target:|environment:/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 4 + BROWSER_UI_PARTS);
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 0);
  assert.equal((workflow.match(/\|\| 'ubuntu-24\.04' }}/g) ?? []).length, 5 + BROWSER_UI_PARTS);
  assert.match(workflow, /xvfb-run -a pnpm test:browser:ci personal/);
  assert.match(workflow, /run: pnpm test:browser:ci browser-ui/);
  assert.match(workflow, /xvfb-run -a node scripts\/browser-profile-e2e\.mjs/);
  assert.match(workflow, /xvfb-run -a node scripts\/shared-browser-studio-e2e\.mjs/);
  assert.match(workflow, /install --yes --no-install-recommends x11-utils sqlite3 postgresql-client/);
  assert.doesNotMatch(workflow, /SUPABASE_DATABASE_ONLY:/);
  assert.match(workflow, /TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres/);
  assert.equal((workflow.match(/if-no-files-found: error/g) ?? []).length, 3 + BROWSER_UI_PARTS);
  assert.match(workflow, /browser-ci\/shared-profile\/result\.json/);
  assert.match(workflow, /browser-ci\/shared-studio\/required-browser-result\.json/);
  assert.doesNotMatch(workflow, /--pass-with-no-tests|--retries=[1-9]|--grep/);
  for (const match of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(match[1], /@[a-f0-9]{40}$/);
  }
});

test("standalone configs do not import the authenticated development harness", () => {
  for (const file of ["playwright.personal-ci.config.ts", "playwright.ci-ui.config.ts", "playwright.shared-studio-ci.config.ts"]) {
    const config = read(`packages/frontend/${file}`);
    assert.match(config, /forbidOnly: true/);
    assert.match(config, /workers: 1/);
    assert.match(config, /retries: 0/);
    assert.match(config, /required-browser-reporter\.mjs/);
    assert.doesNotMatch(config, /globalSetup:|globalTeardown:|playwright\.config|playwright-test\.mjs|dotenv|privateEnv/);
  }
  const vite = read("packages/frontend/vite.ci-ui.config.ts");
  assert.match(vite, /envFile: false/);
  assert.match(vite, /cacheDir: path\.join\(frontendRoot, "node_modules", "\.vite-browser-ui-ci"\)/);
  // The history fixtures use the real Router; a clean lane must optimize it
  // explicitly instead of inheriting a developer's dependency-scan cache.
  // Prebundle the icon barrel too: thousands of per-icon requests previously
  // exhausted the required lane's budget before every case could execute.
  assert.match(vite, /include: \["react", "react-dom\/client", "react-aria-components", "react-router-dom", "iconoir-react"\]/);
  assert.match(vite, /noDiscovery: true/);
  assert.doesNotMatch(vite, /from ["']\.\/vite\.config|loadEnv\(/);
  const resolver = read("packages/frontend/tests/playwright/component/viteComponentDependencies.ts");
  assert.ok(resolver.includes("\\.vite(?:-browser-ui-ci)?"));
});

test("UI config basenames avoid pinned Brotli name detection without changing coverage", () => {
  // Gitleaks 8.30.1 uses archives 0.1.2, whose Brotli.Match treats any
  // case-insensitive ".br" substring as an archive when given a filename.
  const configNames = ["playwright.ci-ui.config.ts", "vite.ci-ui.config.ts"];
  for (const name of configNames) {
    assert.equal(name.toLowerCase().includes(".br"), false);
    assert.ok(fs.statSync(path.join(root, "packages/frontend", name)).isFile());
  }
  for (const name of ["playwright.browser-ui-ci.config.ts", "vite.browser-ui-ci.config.ts"]) {
    assert.equal(fs.existsSync(path.join(root, "packages/frontend", name)), false);
  }
  const playwright = read("packages/frontend/playwright.ci-ui.config.ts");
  assert.equal((playwright.match(/vite\.ci-ui\.config\.ts/g) ?? []).length, 1);
  assert.match(read("packages/frontend/scripts/browser-ci.mjs"),
    /"browser-ui": "playwright\.ci-ui\.config\.ts"/);
  for (const name of ["playwright.notifications-ci.config.ts", "playwright.support-ci.config.ts"]) {
    const consumer = read(`packages/frontend/${name}`);
    assert.equal((consumer.match(/--config \.\/vite\.ci-ui\.config\.ts/g) ?? []).length, 1);
    assert.doesNotMatch(consumer, /vite\.browser-ui-ci\.config\.ts/);
  }
});

test("the first Browser UI part includes the real co-browsing protocol fixture", () => {
  const job = jobSource("browser-ui-1");
  assert.match(job, /name: Browser UI rendering \(1 of 2\)/);
  const install = job.indexOf("playwright install --with-deps chromium");
  const guards = job.indexOf("node --test scripts/shared-browser-cobrowsing-e2e.test.mjs");
  const fixture = job.indexOf("run: node scripts/shared-browser-cobrowsing-e2e.mjs");
  const components = job.indexOf("run: pnpm test:browser:ci browser-ui --shard=1/2\n");
  assert.ok(install >= 0 && guards > install && fixture > guards && components > fixture);
  assert.match(job, /packages\/frontend\/test-results\/browser-ci\/shared-cobrowsing/);
  const beforeChecks = job.slice(0, components).replace("        if: runner.environment == 'self-hosted'\n", "");
  assert.doesNotMatch(beforeChecks, /if:|continue-on-error:|secrets:|secrets\./);
  // The fixture runs once per run: no other job runs it or keeps its results.
  const workflow = read(".github/workflows/browser-e2e.yml");
  for (const text of ["scripts/shared-browser-cobrowsing-e2e.test.mjs", "run: node scripts/shared-browser-cobrowsing-e2e.mjs", "browser-ci/shared-cobrowsing"]) {
    assert.equal(workflow.split(text).length - 1, 1, text);
  }
  assert.ok(fs.existsSync(path.join(root, "scripts/shared-browser-cobrowsing-e2e.mjs")));
  assert.ok(fs.existsSync(path.join(root, "scripts/shared-browser-cobrowsing-e2e.test.mjs")));
});

test("the expanded browser UI inventory has a bounded suite budget without relaxing test gates", () => {
  const config = read("packages/frontend/playwright.ci-ui.config.ts");
  assert.equal(REQUIRED_BROWSER_LANES["browser-ui"].parts, BROWSER_UI_PARTS);
  assert.match(config, /^\s+globalTimeout: 1_800_000,$/m);
  assert.match(config, /^\s+timeout: 30_000,$/m);
  assert.match(config, /^\s+workers: 1,$/m);
  assert.match(config, /^\s+retries: 0,$/m);
  assert.match(config, /^\s+fullyParallel: false,$/m);
  assert.match(config, /^\s+forbidOnly: true,$/m);
  assert.match(config, /^\s+testMatch: REQUIRED_BROWSER_UI_SPECS,$/m);
  assert.match(config, /required-browser-reporter\.mjs", \{ lane: "browser-ui" \}/);
  assert.equal(REQUIRED_BROWSER_LANES["browser-ui"].minimumTests, 55);
  // Each part keeps the lane's former 40-minute job budget; the aggregate has five.
  for (const key of partKeys) {
    assert.match(jobSource(key), /\|\| 'ubuntu-24\.04' }}/);
    assert.deepEqual(jobSource(key).match(/^\s+timeout-minutes: .*$/gmu), ["    timeout-minutes: 40"]);
  }
  assert.deepEqual(jobSource("browser-ui").match(/^\s+timeout-minutes: .*$/gmu), ["    timeout-minutes: 5"]);
});

test("historical workflow proofs reverse only the reviewed Browser UI split and job budget", () => {
  const source = fs.readFileSync(path.join(root, ".github/workflows/browser-e2e.yml"), "utf8");
  const unsplit = withoutBrowserUiParts("browser-e2e.yml", source);
  const job = unsplit.split("\n  browser-ui:\n")[1].split(/\n  [\w-]+:\n/u)[0];
  // The split is exactly the reviewed aggregate and parts built from that one job.
  assert.equal(source.replace(`\n  browser-ui:\n${browserUiAggregateJob(job)}\n  browser-ui-1:\n${browserUiPartJob(job, 1)}`
    + `\n  browser-ui-2:\n${browserUiPartJob(job, 2)}`, () => `\n  browser-ui:\n${job}`), unsplit);
  assert.equal(withoutManualCiRouting("browser-e2e.yml", unsplit),
    withoutBrowserUiParts("browser-e2e.yml", withoutManualCiRouting("browser-e2e.yml", source)));
  const previous = unsplit.replace(job, () => job.replace("    timeout-minutes: 40", "    timeout-minutes: 30"));
  assert.equal(withoutBrowserUiJobBudget("browser-e2e.yml", source), previous);
  assert.equal(withoutBrowserUiJobBudget("build.yml", source), source);
  assert.equal(withoutBrowserUiParts("build.yml", source), source);
  const part = key => source.split(`\n  ${key}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];
  const [aggregate, first, second] = ["browser-ui", "browser-ui-1", "browser-ui-2"].map(part);
  const inFirst = (from, to) => source.replace(first, () => first.replace(from, () => to));
  const inSecond = (from, to) => source.replace(second, () => second.replace(from, () => to));
  const inAggregate = (from, to) => source.replace(aggregate, () => aggregate.replace(from, () => to));
  const bothParts = (from, to) => inFirst(from, to).replace(second, () => second.replace(from, () => to));
  for (const changed of [
    inFirst("    timeout-minutes: 40", "    timeout-minutes: 30"),
    inFirst("    timeout-minutes: 40", "    timeout-minutes: 41"),
    inFirst("    timeout-minutes: 40\n", ""),
    inFirst("    timeout-minutes: 40", "    timeout-minutes: 40\n    timeout-minutes: 40"),
    bothParts("    timeout-minutes: 40", "    timeout-minutes: 30"),
    inSecond("--shard=2/2", "--shard=1/2"),
    inSecond("--shard=2/2", "--shard=2/3"),
    inSecond("--shard=2/2\n", "--shard=2/2 --grep cobrowsing\n"),
    inSecond("      - name: Run browser component rendering proofs\n",
      "      - name: Exercise routine approval and human-input handoff in real Chromium\n        run: node scripts/shared-browser-cobrowsing-e2e.mjs\n      - name: Run browser component rendering proofs\n"),
    inSecond("browser-ui-rendering-2", "browser-ui-rendering-1"),
    inSecond("-public-browser-ui-2\",", "-public-browser-ui-1\","),
    inSecond("    name: Browser UI rendering (2 of 2)", "    name: Browser UI rendering"),
    inAggregate("      - browser-ui-2\n", ""),
    inAggregate("results[key].result, 'success'", "results[key].result === 'skipped' ? 'success' : results[key].result, 'success'"),
    inAggregate("    if: ${{ always() && ", "    if: ${{ "),
    inAggregate("    timeout-minutes: 5", "    timeout-minutes: 40"),
    inAggregate("          pattern: browser-ui-rendering-*\n", "          pattern: browser-ui-rendering-1\n"),
    inAggregate("required-browser-parts.mjs browser-ui", "required-browser-parts.mjs personal"),
    inAggregate("          persist-credentials: false\n", ""),
    source.replace(`\n  browser-ui-1:\n${first}`, "").replace(`\n  browser-ui-2:\n${second}`, () => `\n  browser-ui-2:\n${second}\n  browser-ui-1:\n${first}`),
    source.replace(`\n  browser-ui:\n${aggregate}`, ""),
    source.replace("\n  browser-ui:\n", "\n  another-job:\n"),
    source + "\n  browser-ui-2:\n" + second,
  ]) {
    assert.notEqual(changed, source);
    assert.throws(() => withoutBrowserUiJobBudget("browser-e2e.yml", changed));
  }
});

test("the required Browser UI check runs after both parts and passes only when both succeeded", () => {
  const aggregate = jobSource("browser-ui");
  assert.deepEqual(aggregate.match(/^    needs:\n((?:      - .+\n)+)/mu)?.[1].trim().split("\n").map(line => line.trim().slice(2)), partKeys);
  assert.ok(aggregate.includes("    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}\n"));
  const program = aggregate.match(/      - name: Require both Browser UI parts to succeed\n        env:\n          BROWSER_UI_RESULTS: \$\{\{ toJSON\(needs\) \}\}\n        shell: bash\n        run: \|\n          node <<'NODE'\n([\s\S]*?)          NODE\n/u)?.[1];
  assert.ok(program);
  const check = results => vm.runInNewContext(program.replace(/^          /gmu, ""), {
    require: name => { assert.equal(name, "node:assert/strict"); return assert; },
    process: { env: { BROWSER_UI_RESULTS: JSON.stringify(results) } },
  }, { timeout: 1000 });
  const success = Object.fromEntries(partKeys.map(key => [key, { result: "success", outputs: {} }]));
  assert.doesNotThrow(() => check(success));
  for (const key of partKeys) {
    // A skipped or cancelled part never counts as passing.
    for (const result of ["failure", "cancelled", "skipped", "timed_out", "neutral", "", "Success", null]) {
      assert.throws(() => check({ ...success, [key]: { result } }), `${key}/${result}`);
    }
    const missing = { ...success }; delete missing[key]; assert.throws(() => check(missing));
  }
  for (const malformed of [{}, [], null, { ...success, unexpected: { result: "success" } }]) assert.throws(() => check(malformed));
});

test("the required Browser UI check proves the lane's whole contract on both parts' own results", () => {
  const aggregate = jobSource("browser-ui");
  const steps = aggregate.split("      - name: ").slice(1).map(step => step.split("\n")[0]);
  assert.deepEqual(steps, ["Qualify isolated browser CI runner", "Require both Browser UI parts to succeed", "Checkout the tested revision",
    "Download both parts' results", "Require every required case across both parts"]);
  assert.ok(aggregate.includes("        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n"
    + "        with:\n          pattern: browser-ui-rendering-*\n          path: ${{ runner.temp }}/browser-ui-parts\n"));
  assert.ok(aggregate.endsWith("        run: node packages/frontend/scripts/required-browser-parts.mjs browser-ui \"$RUNNER_TEMP/browser-ui-parts\"\n"));
  assert.doesNotMatch(aggregate, /merge-multiple|run-id|github-token|continue-on-error|secrets\.|pnpm/u);
  // Each part runs its literal share of the lane and keeps its own results under
  // a name the download pattern matches; no other artifact of this workflow does.
  const workflow = read(".github/workflows/browser-e2e.yml");
  const artifacts = [...workflow.matchAll(/^          name: (.+)$/gmu)].map(match => match[1]);
  assert.deepEqual(artifacts.filter(name => name.startsWith("browser-ui-rendering-")), partKeys.map((_, index) => `browser-ui-rendering-${index + 1}`));
  assert.ok(artifacts.every(name => !name.startsWith("browser-ui-rendering") || /^browser-ui-rendering-\d+$/u.test(name)));
  for (const [index, key] of partKeys.entries()) {
    const job = jobSource(key);
    assert.equal((job.match(/pnpm test:browser:ci/gu) ?? []).length, 1, key);
    assert.ok(job.includes(`      - name: Run browser component rendering proofs\n        run: pnpm test:browser:ci browser-ui --shard=${index + 1}/${BROWSER_UI_PARTS}\n`), key);
    assert.ok(job.includes(`          name: browser-ui-rendering-${index + 1}\n          path: |\n            packages/frontend/test-results/browser-ci/browser-ui\n`), key);
  }
  assert.ok(fs.statSync(path.join(root, "packages/frontend/scripts/required-browser-parts.mjs")).isFile());
});
