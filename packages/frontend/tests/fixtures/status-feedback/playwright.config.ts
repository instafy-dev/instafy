import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../../", import.meta.url));
const baseURL = process.env.INSTAFY_STATUS_FEEDBACK_URL ?? "http://127.0.0.1:5392";
export default defineConfig({
  testDir: "../../playwright/component", testMatch: "status-feedback.spec.ts",
  workers: 1, retries: 0, forbidOnly: true, timeout: 30_000,
  reporter: "list", outputDir: "../../../test-results/status-feedback",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL === "chrome" ? "chrome" : undefined } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "pnpm exec vite --config tests/fixtures/status-feedback/vite.config.ts --port 5392",
    cwd: frontend, url: `${baseURL}/tests/fixtures/status-feedback/index.html`,
    reuseExistingServer: !process.env.CI, timeout: 60_000,
  },
});
