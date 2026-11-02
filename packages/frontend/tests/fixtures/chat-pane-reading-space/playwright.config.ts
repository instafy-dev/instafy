import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "reading-space.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: {timeout: 10_000}, reporter: "list",
  outputDir: "../../../test-results/chat-pane-reading-space",
  use: { channel: "chrome", headless: true, launchOptions: {ignoreDefaultArgs: ["--hide-scrollbars"]}, trace: "retain-on-failure" },
});
