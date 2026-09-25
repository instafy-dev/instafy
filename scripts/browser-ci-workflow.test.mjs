import { withoutManualCiRouting } from "./lib/manualCiRoutingTestBaseline.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => withoutManualCiRouting(path.basename(relative), fs.readFileSync(path.join(root, relative), "utf8"));

const routedJobs = [
  { key: "personal", label: "public-browser-personal", name: "Personal Browser E2E", minutes: 30 },
  { key: "browser-ui", label: "public-browser-ui", name: "Browser UI rendering", minutes: 30 },
];
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

test("browser routing is independently default-off and preserves the exact two job names and budgets", () => {
  for (const job of routedJobs) for (const event of ["pull_request", "push"]) {
    for (const flag of ["", "false", "0", "unknown"]) assert.equal(selectBrowser(job, callerContext(event), flag), "ubuntu-24.04");
    assert.ok(jobSource(job.key).includes(`    name: ${job.name}\n`));
    assert.ok(jobSource(job.key).includes(`    timeout-minutes: ${job.minutes}\n`));
  }
  const shared = jobSource("shared-profile");
  assert.match(shared, /vars\.CI_SHARED_BROWSER_SELF_HOSTED/u);
  assert.match(shared, /^    timeout-minutes: 5$/mu);
  assert.doesNotMatch(shared, /vars\.CI_BROWSER_SELF_HOSTED/u);
  assert.equal((read(".github/workflows/browser-e2e.yml").match(/vars\.CI_BROWSER_SELF_HOSTED/g) ?? []).length, 2);
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
    assert.deepEqual(tools, ["bash", "git", "curl", "tar", "unzip", "sudo", "apt-get", "xvfb-run", "Xvfb", "xauth"]);
    for (const tool of tools) assert.throws(() => qualifyBrowser(job, () => {}, tool));
    for (const mutate of [s => { s.platform = "darwin"; }, s => { s.arch = "x64"; }, s => { s.getuid = () => 0; },
      s => { s.versions.node = "20.20.2"; }, s => { s.env.RUNNER_OS = "macOS"; }, s => { s.env.RUNNER_ARCH = "X64"; },
      s => { delete s.env.INSTAFY_CI_JOB_ISOLATION; }, s => { s.env.INSTAFY_ENV_DIR = "/inert-private-env"; }]) {
      assert.throws(() => qualifyBrowser(job, mutate));
    }
    assert.equal((jobSource(job.key).match(/^        if: /gmu) ?? []).length, job.key === "personal" ? 3 : 2,
      "only qualification, Personal native dependency setup and always-upload may be conditional");
  }
});

test("only the self-hosted Personal job installs its documented GTK3 dependency before the native fixture build", () => {
  const personal = jobSource("personal");
  const step = "      - name: Install Linux Electron runtime dependency\n        if: runner.environment == 'self-hosted'\n        run: sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libgtk-3-0t64\n";
  assert.ok(personal.includes(step));
  assert.ok(personal.indexOf(step) > personal.indexOf("playwright install --with-deps chromium"));
  assert.ok(personal.indexOf(step) < personal.indexOf("pnpm --filter @instafy/desktop-runtime-agent build"));
  for (const key of ["browser-ui", "shared-profile"]) assert.doesNotMatch(jobSource(key), /libgtk-3-0t64|Install Linux Electron runtime dependency/u);
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
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 4);
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 0);
  assert.equal((workflow.match(/\|\| 'ubuntu-24\.04' }}/g) ?? []).length, 5);
  assert.match(workflow, /xvfb-run -a pnpm test:browser:ci personal/);
  assert.match(workflow, /run: pnpm test:browser:ci browser-ui/);
  assert.match(workflow, /xvfb-run -a node scripts\/browser-profile-e2e\.mjs/);
  assert.match(workflow, /xvfb-run -a node scripts\/shared-browser-studio-e2e\.mjs/);
  assert.match(workflow, /install --yes --no-install-recommends x11-utils sqlite3 postgresql-client/);
  assert.doesNotMatch(workflow, /SUPABASE_DATABASE_ONLY:/);
  assert.match(workflow, /TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres/);
  assert.equal((workflow.match(/if-no-files-found: error/g) ?? []).length, 4);
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
  assert.match(vite, /include: \["react", "react-dom\/client", "react-aria-components", "react-router-dom"\]/);
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

test("the required browser UI job includes the real co-browsing protocol fixture", () => {
  const workflow = read(".github/workflows/browser-e2e.yml");
  const job = workflow.split("\n  browser-ui:\n")[1].split("\n  shared-profile:\n")[0];
  assert.match(job, /name: Browser UI rendering/);
  const install = job.indexOf("playwright install --with-deps chromium");
  const guards = job.indexOf("node --test scripts/shared-browser-cobrowsing-e2e.test.mjs");
  const fixture = job.indexOf("run: node scripts/shared-browser-cobrowsing-e2e.mjs");
  const components = job.indexOf("run: pnpm test:browser:ci browser-ui");
  assert.ok(install >= 0 && guards > install && fixture > guards && components > fixture);
  assert.match(job, /packages\/frontend\/test-results\/browser-ci\/shared-cobrowsing/);
  const beforeChecks = job.slice(0, components).replace("        if: runner.environment == 'self-hosted'\n", "");
  assert.doesNotMatch(beforeChecks, /if:|continue-on-error:|secrets:|secrets\./);
  assert.ok(fs.existsSync(path.join(root, "scripts/shared-browser-cobrowsing-e2e.mjs")));
  assert.ok(fs.existsSync(path.join(root, "scripts/shared-browser-cobrowsing-e2e.test.mjs")));
});

test("the expanded browser UI inventory has a bounded suite budget without relaxing test gates", () => {
  const config = read("packages/frontend/playwright.ci-ui.config.ts");
  assert.match(config, /^\s+globalTimeout: 360_000,$/m);
  assert.match(config, /^\s+timeout: 30_000,$/m);
  assert.match(config, /^\s+workers: 1,$/m);
  assert.match(config, /^\s+retries: 0,$/m);
  assert.match(config, /^\s+fullyParallel: false,$/m);
  assert.match(config, /^\s+forbidOnly: true,$/m);
  assert.match(config, /^\s+testMatch: REQUIRED_BROWSER_UI_SPECS,$/m);
  assert.match(config, /required-browser-reporter\.mjs", \{ lane: "browser-ui" \}/);
  assert.equal(REQUIRED_BROWSER_LANES["browser-ui"].minimumTests, 40);
  const workflow = read(".github/workflows/browser-e2e.yml");
  const job = workflow.split("\n  browser-ui:\n")[1].split("\n  shared-profile:\n")[0];
  assert.match(job, /\|\| 'ubuntu-24\.04' }}/);
  assert.match(job, /^\s+timeout-minutes: 30$/m);
});
