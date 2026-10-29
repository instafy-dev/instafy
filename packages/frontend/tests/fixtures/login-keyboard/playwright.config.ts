import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../playwright/component",
  testMatch: "login-keyboard.spec.ts",
  workers: 1, retries: 0, timeout: 30_000,
  reporter: "list",
  outputDir: "../../../test-results/login-keyboard",
  use: {
    baseURL: process.env.INSTAFY_LOGIN_KEYBOARD_URL ?? "http://127.0.0.1:5337",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : undefined,
  },
});
