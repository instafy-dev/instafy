import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "reading-flow.spec.ts", workers: 1, retries: 0,
  timeout: 40_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: `../../../test-results/search-reading-flow-${process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after"}`,
  use: { baseURL: process.env.INSTAFY_SEARCH_READING_URL ?? "http://127.0.0.1:5400",
    channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true,
    trace: "retain-on-failure", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } },
});
