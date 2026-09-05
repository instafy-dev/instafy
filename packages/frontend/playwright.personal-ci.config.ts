import { defineConfig } from "@playwright/test";

// This lane is an explicit request to exercise native Personal Browser. An
// ambient opt-out must not turn a required CI check into a skipped green run.
process.env.PLAYWRIGHT_ELECTRON_PERSONAL_BROWSER = "1";

export default defineConfig({
  testDir: "./tests/playwright/smoke",
  testMatch: "electron-personal-browser.spec.ts",
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  globalTimeout: 180_000,
  outputDir: "test-results/browser-ci/personal",
  reporter: [
    ["list"],
    ["./scripts/required-browser-reporter.mjs", { lane: "personal" }],
  ],
  // The spec traces its manually launched Electron contexts separately. Those
  // traces contain only disposable localhost fixture data and survive failures.
  use: { trace: "retain-on-failure" },
});
