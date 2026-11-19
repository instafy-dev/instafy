import { defineConfig } from "@playwright/test";

export default defineConfig({ testDir: ".", testMatch: "consistency.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 7000 }, reporter: "list", outputDir: "../../../test-results/browser-composer-consistency",
  use: { baseURL: process.env.INSTAFY_CONSISTENCY_REVIEW_URL ?? "http://127.0.0.1:5460",
    channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true, trace: "retain-on-failure" },
});
