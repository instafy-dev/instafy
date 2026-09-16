import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REQUIRED_BROWSER_LANES } from "../packages/frontend/scripts/required-browser-reporter.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const browserJobs = [
  { key: "personal", name: "Personal Browser E2E", minutes: 30, conditionalSteps: 1 },
  { key: "browser-ui", name: "Browser UI rendering", minutes: 30, conditionalSteps: 1 },
];
const jobSource = key => read(".github/workflows/browser-e2e.yml").split(`\n  ${key}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];

test("both browser jobs run on hosted Ubuntu 24.04 with their exact names and budgets", () => {
  for (const job of browserJobs) {
    const source = jobSource(job.key);
    assert.ok(source.includes(`    name: ${job.name}\n    runs-on: ubuntu-24.04\n`));
    assert.ok(source.includes(`    timeout-minutes: ${job.minutes}\n`));
    assert.doesNotMatch(source, /runner\.environment|self-hosted|Qualify isolated|libgtk/u);
    assert.equal((source.match(/^        if: /gmu) ?? []).length, job.conditionalSteps,
      "only the always-upload step may be conditional");
  }
  assert.match(jobSource("shared-profile"), /^    timeout-minutes: 5$/mu);
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
  assert.equal((workflow.match(/^    runs-on: ubuntu-24\.04$/gmu) ?? []).length, 5);
  assert.equal((workflow.match(/runs-on:/g) ?? []).length, 5);
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
  assert.doesNotMatch(job.slice(0, components), /if:|continue-on-error:|secrets:|secrets\./);
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
  assert.equal(REQUIRED_BROWSER_LANES["browser-ui"].minimumTests, 39);
  const workflow = read(".github/workflows/browser-e2e.yml");
  const job = workflow.split("\n  browser-ui:\n")[1].split("\n  shared-profile:\n")[0];
  assert.match(job, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(job, /^\s+timeout-minutes: 30$/m);
});
