import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const external = process.env.INSTAFY_CLI_LOGIN_LAYOUT_URL;
const baseURL = external ?? "http://127.0.0.1:5343";

export default defineConfig({
  testDir: "../../playwright/component",
  testMatch: "cli-login-layout.spec.ts",
  workers: 1, retries: 0, timeout: 30_000,
  reporter: "list",
  outputDir: "../../../test-results/cli-login-layout",
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : undefined,
  },
  // Starts the fixture's own server unless INSTAFY_CLI_LOGIN_LAYOUT_URL names one.
  webServer: external ? undefined : {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: "pnpm exec vite --config tests/fixtures/cli-login-layout/vite.config.ts --port 5343 --strictPort",
    url: `${baseURL}/tests/fixtures/cli-login-layout/index.html`,
    reuseExistingServer: false, timeout: 60_000,
  },
});
