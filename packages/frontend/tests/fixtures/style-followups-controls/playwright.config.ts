import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: "controls.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  outputDir: "../../../test-results/style-followups-controls",
  use: { baseURL: "http://127.0.0.1:5242", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec vite --config tests/fixtures/style-followups-controls/vite.config.ts --port 5242",
    cwd: frontend,
    url: "http://127.0.0.1:5242/tests/fixtures/style-followups-controls/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
