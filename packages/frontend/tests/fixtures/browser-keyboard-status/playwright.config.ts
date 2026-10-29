import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../playwright/component",
  testMatch: "browser-keyboard-status.spec.ts",
  workers: 1, retries: 0, timeout: 30_000,
  reporter: "list",
  outputDir: "../../../test-results/browser-keyboard-status",
  use: {
    baseURL: process.env.INSTAFY_BROWSER_KEYBOARD_STATUS_URL ?? "http://127.0.0.1:5332",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : undefined,
  },
});
