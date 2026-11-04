import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Gutter behavior is new: keep the documented baseline capture on the old suite.
  testMatch: process.env.INSTAFY_REVIEW_VERSION === "before"
    ? ["reading-space.spec.ts"]
    : ["reading-space.spec.ts", "composer-gutters.spec.ts"],
  workers: 1, retries: 0,
  timeout: 30_000, expect: {timeout: 10_000}, reporter: "list",
  outputDir: "../../../test-results/chat-pane-reading-space",
  use: { channel: "chrome", headless: true, launchOptions: {ignoreDefaultArgs: ["--hide-scrollbars"]}, trace: "retain-on-failure" },
});
