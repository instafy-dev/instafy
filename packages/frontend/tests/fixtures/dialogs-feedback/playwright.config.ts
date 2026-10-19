import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const external = process.env.INSTAFY_REVIEW_URL;
const baseURL = external ?? "http://127.0.0.1:5211";
export default defineConfig({
  testDir: ".", testMatch: ["responsive.spec.ts", "button-presets.spec.ts"], forbidOnly: true, workers: 1, retries: 0,
  timeout: 45000, reporter: "list", outputDir: "../../../test-results/dialogs-feedback",
  use: { baseURL, trace: "off", actionTimeout: 10000 },
  webServer: external ? undefined : {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: "pnpm exec vite --config tests/fixtures/dialogs-feedback/vite.config.ts --port 5211 --strictPort",
    url: baseURL, reuseExistingServer: false, timeout: 60000,
  },
});
