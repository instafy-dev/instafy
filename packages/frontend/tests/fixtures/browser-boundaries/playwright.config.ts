import { defineConfig } from "@playwright/test";

// Start only the dedicated Vite fixture server described in README.md.
export default defineConfig({
  testDir: ".",
  testMatch: "boundaries.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir: "../../../test-results/browser-boundaries",
  use: {
    baseURL: process.env.INSTAFY_BROWSER_BOUNDARIES_URL ?? "http://127.0.0.1:5217",
    trace: "off",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : undefined,
  },
});
