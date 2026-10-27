import { defineConfig } from "@playwright/test";

// Explicit native lane: missing Electron/build is a failure, never a skip.
export default defineConfig({
  testDir: "./tests/playwright/smoke",
  testMatch: "electron-browser-switch.spec.ts",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  globalTimeout: 600_000,
  outputDir: "test-results/electron-browser-switch",
  reporter: [["list"]],
  webServer: {
    command: "pnpm exec vite --config tests/fixtures/electron-browser-switch/vite.config.ts",
    url: "http://127.0.0.1:5305/tests/fixtures/electron-browser-switch/index.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
