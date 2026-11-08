import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "browser-address.spec.ts", workers: 1, retries: 0, timeout: 30_000,
  expect: { timeout: 7000 }, reporter: "list", outputDir: "../../../test-results/browser-address-review",
  use: { baseURL: process.env.INSTAFY_BROWSER_ADDRESS_URL ?? "http://127.0.0.1:5427", channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true, trace: "retain-on-failure" } });
