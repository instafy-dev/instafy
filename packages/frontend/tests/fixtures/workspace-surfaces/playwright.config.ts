import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const baseURL = "http://127.0.0.1:5205";

// Kept separate from authenticated app tests: these panels require the fixture's
// data-boundary aliases. Always start our isolated server, never reuse the app.
export default defineConfig({
  testDir: ".",
  testMatch: "responsive.spec.ts",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir: "../../../test-results/workspace-surfaces",
  use: { ...devices["Desktop Chrome"], baseURL, trace: "off" },
  webServer: {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: "pnpm exec vite --config tests/fixtures/workspace-surfaces/vite.config.ts --port 5205 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
