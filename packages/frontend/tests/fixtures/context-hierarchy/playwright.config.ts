import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["responsive.spec.ts", "sidebar.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: "list",
  outputDir: "../../../test-results/context-hierarchy",
  use: {
    baseURL: "http://127.0.0.1:5368",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm exec vite --config tests/fixtures/context-hierarchy/vite.config.ts --host 127.0.0.1 --port 5368",
    url: "http://127.0.0.1:5368/tests/fixtures/context-hierarchy/index.html",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
