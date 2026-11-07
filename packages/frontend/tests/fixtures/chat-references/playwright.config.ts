import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "chat-references.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: "../../../test-results/chat-references",
  use: { baseURL: process.env.INSTAFY_CHAT_REFERENCES_URL ?? "http://127.0.0.1:5420",
    channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true,
    trace: "retain-on-failure", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } },
});
