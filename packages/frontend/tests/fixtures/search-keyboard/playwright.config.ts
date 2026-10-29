import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../playwright/component", testMatch: "search-keyboard.spec.ts", workers: 1, retries: 0, timeout: 30_000,
  reporter: "list", outputDir: "../../../test-results/search-keyboard",
  use: { baseURL: process.env.INSTAFY_SEARCH_KEYBOARD_URL ?? "http://127.0.0.1:5341", trace: "retain-on-failure" },
});
