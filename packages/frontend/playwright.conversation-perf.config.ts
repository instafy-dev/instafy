import { defineConfig, devices } from "@playwright/test";

const channel = process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL?.trim();
if (channel && !["chrome", "chromium"].includes(channel)) throw new Error("PLAYWRIGHT_BROWSER_UI_CHANNEL must be chrome or chromium");

export default defineConfig({
  testDir: "./tests/playwright/conversation-perf",
  testMatch: "*.spec.ts",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  globalTimeout: 600_000,
  outputDir: "test-results/conversation-perf",
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5207", channel: channel || undefined, trace: "retain-on-failure" },
  webServer: {
    command: "node ./tests/playwright/conversation-perf/server.mjs",
    url: "http://127.0.0.1:5207",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
