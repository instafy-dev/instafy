import { defineConfig, devices } from "@playwright/test";

if (!process.env.INSTAFY_STUDIO_E2E_FIXTURE) {
  throw new Error("Run scripts/shared-browser-studio-e2e.mjs; no external-stack fallback is supported.");
}
process.env.PLAYWRIGHT_SHARED_BROWSER_STUDIO_CI = "1";

export default defineConfig({
  testDir: "./tests/playwright/smoke",
  testMatch: ["shared-browser-studio-ci.spec.ts"],
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  globalTimeout: 660_000,
  outputDir: "test-results/browser-ci/shared-studio",
  reporter: [["list"], ["./scripts/required-browser-reporter.mjs", { lane: "shared-studio" }]],
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    // The test uses disposable sessions, but session-bearing HTTP/WebSocket
    // grants still do not belong in public retained artifacts.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
