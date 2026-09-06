import { defineConfig, devices } from "@playwright/test";
import { constants, accessSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const fixturePath = process.env.INSTAFY_STUDIO_E2E_FIXTURE;
if (!fixturePath) {
  throw new Error("Run scripts/shared-browser-studio-e2e.mjs; no external-stack fallback is supported.");
}
if (!path.isAbsolute(fixturePath)) {
  throw new Error("Shared Studio CI requires an absolute owned fixture path.");
}

let browserExecutablePath: string;
try {
  const fixtureStat = lstatSync(fixturePath);
  if (!fixtureStat.isFile() || fixtureStat.nlink !== 1 || (fixtureStat.mode & 0o777) !== 0o600 ||
      fixtureStat.size > 64 * 1024) {
    throw new Error("unsafe fixture");
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    browserExecutablePath?: unknown;
  };
  if (typeof fixture.browserExecutablePath !== "string" ||
      !path.isAbsolute(fixture.browserExecutablePath) ||
      realpathSync(fixture.browserExecutablePath) !== fixture.browserExecutablePath ||
      !statSync(fixture.browserExecutablePath).isFile()) {
    throw new Error("invalid browser executable");
  }
  accessSync(fixture.browserExecutablePath, constants.X_OK);
  browserExecutablePath = fixture.browserExecutablePath;
} catch {
  throw new Error("The owned Shared Studio fixture's pinned Chromium executable is missing or not executable.");
}
process.env.PLAYWRIGHT_SHARED_BROWSER_STUDIO_CI = "1";

export default defineConfig({
  testDir: "./tests/playwright/smoke",
  testMatch: ["shared-browser-studio-ci.spec.ts"],
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  globalTimeout: 660_000,
  outputDir: "test-results/browser-ci/shared-studio",
  reporter: [["list"], ["./scripts/required-browser-reporter.mjs", { lane: "shared-studio" }]],
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    launchOptions: { executablePath: browserExecutablePath },
    // The test uses disposable sessions, but session-bearing HTTP/WebSocket
    // grants still do not belong in public retained artifacts.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
