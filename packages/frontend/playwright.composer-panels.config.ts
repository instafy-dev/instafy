import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright/component",
  testMatch: "composer-panels.spec.ts",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: "test-results/composer-panels",
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5310", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec vite --config tests/fixtures/composer-panels/vite.config.ts",
    url: "http://127.0.0.1:5310/tests/fixtures/composer-panels/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
