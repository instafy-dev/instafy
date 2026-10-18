import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const external = process.env.INSTAFY_REVIEW_URL;
const baseURL = external ?? "http://127.0.0.1:5208";
export default defineConfig({ testDir: ".", testMatch: "responsive.spec.ts", forbidOnly: true, workers: 1, retries: 0, timeout: 40000, reporter: "list", outputDir: "../../../test-results/menus-forms", use: { baseURL, trace: "off" },
 webServer: external ? undefined : { cwd: fileURLToPath(new URL("../../../", import.meta.url)), command: "pnpm exec vite --config tests/fixtures/menus-forms/vite.config.ts --port 5208 --strictPort", url: baseURL, reuseExistingServer: false, timeout: 60000 },
});
