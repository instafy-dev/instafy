import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = 5_206;
const baseURL = `http://127.0.0.1:${port}`;
const channel = process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL?.trim();
if (channel && channel !== "chrome" && channel !== "chromium") {
  throw new Error("PLAYWRIGHT_BROWSER_UI_CHANNEL must be chrome or chromium");
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const vite = fileURLToPath(new URL("./node_modules/vite/bin/vite.js", import.meta.url));

/** Real production center, presentation ledger and HTTP client; synthetic auth,
 * controller persistence and OS delivery. No env files, accounts or providers. */
export default defineConfig({
  testDir: "./tests/playwright/component",
  testMatch: "notification-lifecycle.spec.ts",
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  globalTimeout: 240_000,
  outputDir: "test-results/notifications-ci",
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL, channel: channel || undefined, headless: true, trace: "retain-on-failure" },
  webServer: {
    command: `${quote(process.execPath)} ${quote(vite)} --config ./vite.browser-ui-ci.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
