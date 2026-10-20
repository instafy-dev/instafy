// Local runner for the Octo turn eval (docs/Octo-Turn-Eval.md) against an already running stack.
// Deliberately no web server, no global setup/teardown and no runtime cleanup reporter: those belong to the
// default config and remove every instafy-runtime-* container on the machine, including other people's.
// The spec stops only the runtime containers of the spaces it created.
import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
process.env.PLAYWRIGHT_CONTROLLER_URL ||= "http://127.0.0.1:8788";
process.env.PLAYWRIGHT_CLEANUP_RUNTIME = "0";

export default defineConfig({
  testDir: here,
  testMatch: "octo-turn-eval.spec.ts",
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: path.resolve(repoRoot, "tmp/octo-turn/test-results"),
  use: {
    baseURL: process.env.PLAYWRIGHT_EXTERNAL_BASE_URL || "http://localhost:5173",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
