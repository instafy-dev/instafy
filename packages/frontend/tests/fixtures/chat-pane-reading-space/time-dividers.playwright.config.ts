import { defineConfig } from "@playwright/test";
import { TIMELINE_REVIEW_TIMEZONE } from "./timelineScenario";

export default defineConfig({
  testDir: ".", testMatch: "time-dividers.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: "../../../test-results/chat-time-dividers",
  use: {
    channel: "chrome", headless: true, timezoneId: TIMELINE_REVIEW_TIMEZONE,
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
    trace: "retain-on-failure",
  },
});
