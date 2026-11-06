import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "message-actions.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: "../../../test-results/message-actions",
  use: { baseURL: process.env.INSTAFY_MESSAGE_ACTIONS_URL ?? "http://127.0.0.1:5412",
    channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true,
    trace: "retain-on-failure", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } },
});
