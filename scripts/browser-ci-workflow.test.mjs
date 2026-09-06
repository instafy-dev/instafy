import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("Public Build includes browser verification in its existing release result", () => {
  const build = read(".github/workflows/build.yml");
  assert.match(build, /\n  pull_request:/);
  assert.match(build, /\n  push:\n    branches:\n      - main/);
  assert.match(build, /\n  browser-verification:\n    name: Browser verification\n    uses: \.\/\.github\/workflows\/browser-e2e\.yml\n    permissions:\n      contents: read/);
});

test("required browser lanes execute without secret or production authority", () => {
  const workflow = read(".github/workflows/browser-e2e.yml");
  assert.match(workflow, /\n  workflow_call:/);
  assert.doesNotMatch(workflow, /secrets:|secrets\.|continue-on-error:|pull_request_target:|self-hosted|environment:/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 3);
  assert.match(workflow, /xvfb-run -a pnpm test:browser:ci personal/);
  assert.match(workflow, /run: pnpm test:browser:ci browser-ui/);
  assert.match(workflow, /xvfb-run -a node scripts\/browser-profile-e2e\.mjs/);
  assert.match(workflow, /xvfb-run -a node scripts\/shared-browser-studio-e2e\.mjs/);
  assert.match(workflow, /apt-get install -y x11-utils sqlite3 postgresql-client/);
  assert.doesNotMatch(workflow, /SUPABASE_DATABASE_ONLY:/);
  assert.match(workflow, /TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres/);
  assert.equal((workflow.match(/if-no-files-found: error/g) ?? []).length, 3);
  assert.match(workflow, /browser-ci\/shared-profile\/result\.json/);
  assert.match(workflow, /browser-ci\/shared-studio\/required-browser-result\.json/);
  assert.doesNotMatch(workflow, /--pass-with-no-tests|--retries=[1-9]|--grep/);
  for (const match of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(match[1], /@[a-f0-9]{40}$/);
  }
});

test("standalone configs do not import the authenticated development harness", () => {
  for (const file of ["playwright.personal-ci.config.ts", "playwright.browser-ui-ci.config.ts", "playwright.shared-studio-ci.config.ts"]) {
    const config = read(`packages/frontend/${file}`);
    assert.match(config, /forbidOnly: true/);
    assert.match(config, /workers: 1/);
    assert.match(config, /retries: 0/);
    assert.match(config, /required-browser-reporter\.mjs/);
    assert.doesNotMatch(config, /globalSetup:|globalTeardown:|playwright\.config|playwright-test\.mjs|dotenv|privateEnv/);
  }
  const vite = read("packages/frontend/vite.browser-ui-ci.config.ts");
  assert.match(vite, /envFile: false/);
  assert.match(vite, /cacheDir: path\.join\(frontendRoot, "node_modules", "\.vite-browser-ui-ci"\)/);
  assert.match(vite, /include: \["react", "react-dom\/client", "react-aria-components"\]/);
  assert.match(vite, /noDiscovery: true/);
  assert.doesNotMatch(vite, /from ["']\.\/vite\.config|loadEnv\(/);
  const resolver = read("packages/frontend/tests/playwright/component/viteComponentDependencies.ts");
  assert.ok(resolver.includes("\\.vite(?:-browser-ui-ci)?"));
});
