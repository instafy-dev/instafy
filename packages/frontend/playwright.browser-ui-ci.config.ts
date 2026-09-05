import { defineConfig, devices } from "@playwright/test";

const PORT = 5_204;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function resolveBrowserChannel(): "chrome" | "chromium" | undefined {
  const value = (process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "").trim();
  if (value === "") {
    return undefined;
  }
  if (value === "chrome" || value === "chromium") {
    return value;
  }
  throw new Error(
    "PLAYWRIGHT_BROWSER_UI_CHANNEL must be either chrome or chromium when set",
  );
}

const BROWSER_CHANNEL = resolveBrowserChannel();

/**
 * Required, synthetic browser-component coverage.
 *
 * These specs mount real production UI components in Chromium, but stub their
 * data and transport edges. They intentionally do not claim full Shared
 * Browser, controller, authentication, or runtime end-to-end coverage.
 * Keep this allowlist explicit so adding an environment-gated component spec
 * cannot silently broaden or weaken the required CI lane.
 */
const REQUIRED_BROWSER_UI_SPECS = [
  "browser-chrome-mobile-layout.spec.ts",
  "browser-cursor-overlay.spec.ts",
  "browser-live-proof.spec.ts",
  "shared-browser-approval-responsive.spec.ts",
];

export default defineConfig({
  testDir: "./tests/playwright/component",
  testMatch: REQUIRED_BROWSER_UI_SPECS,
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 180_000,
  outputDir: "test-results/browser-ci/browser-ui",
  reporter: [
    ["list"],
    ["./scripts/required-browser-reporter.mjs", { lane: "browser-ui" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    // CI leaves this unset and uses the workflow-installed Playwright
    // Chromium. Developers may select one of the two validated installed
    // Chromium channels for the same real-browser proof.
    channel: BROWSER_CHANNEL,
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `pnpm exec vite --config ./vite.browser-ui-ci.config.ts ` +
      `--host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
