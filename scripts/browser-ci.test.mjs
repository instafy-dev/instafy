import assert from "node:assert/strict";
import test from "node:test";
import { browserCiEnvironment, runBrowserCi } from "../packages/frontend/scripts/browser-ci.mjs";

test("browser CI keeps OS/display settings but cannot inherit credentials or development endpoints", () => {
  const source = {
    PATH: "/fixture/bin", HOME: "/fixture/home", DISPLAY: ":99", TMPDIR: "/fixture/tmp",
    PLAYWRIGHT_BROWSERS_PATH: "/fixture/browsers", CI: "0", NODE_OPTIONS: "--require=/unsafe.js",
    INSTAFY_ENV_DIR: "/private/env", DATABASE_URL: "remote-database", GH_TOKEN: "fixture-token",
    VITE_SUPABASE_URL: "https://remote.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-key",
    OPENAI_API_KEY: "fixture-key", CODEX_HOME: "/private/auth", CONTROLLER_URL: "https://remote.invalid",
    PLAYWRIGHT_ELECTRON_EXECUTABLE_PATH: "/some/installed/user/app", HTTP_PROXY: "https://remote.invalid",
  };
  assert.deepEqual(browserCiEnvironment(source), {
    PATH: source.PATH, HOME: source.HOME, DISPLAY: source.DISPLAY, TMPDIR: source.TMPDIR,
    PLAYWRIGHT_BROWSERS_PATH: source.PLAYWRIGHT_BROWSERS_PATH, CI: "1",
  });
  assert.equal(source.CI, "0");
});

test("browser CI rejects filters, reporter overrides, unknown lanes and missing lane", async () => {
  for (const args of [[], ["unknown"], ["constructor"], ["personal", "--grep", "one"],
    ["browser-ui", "--reporter=list"], ["personal", "--pass-with-no-tests"]]) {
    await assert.rejects(runBrowserCi(args), /Usage:/);
  }
});
