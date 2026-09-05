import assert from "node:assert/strict";
import test from "node:test";
import { browserCiEnvironment, personalBrowserFixtureEnvironment, runBrowserCi } from "../packages/frontend/scripts/browser-ci.mjs";

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

test("both browser CI environment boundaries preserve display authorization without credentials", () => {
  const display = {
    PATH: "/fixture/bin", SystemRoot: "/fixture/windows", WINDIR: "/fixture/windows",
    DISPLAY: ":99", XAUTHORITY: "/fixture/xvfb/Xauthority",
    WAYLAND_DISPLAY: "wayland-fixture", XDG_RUNTIME_DIR: "/fixture/runtime",
  };
  const source = {
    ...display,
    HOME: "/fixture/home", USERPROFILE: "/fixture/user", TMPDIR: "/fixture/tmp",
    OPENAI_API_KEY: "must-not-copy", SUPABASE_SERVICE_ROLE_KEY: "must-not-copy",
    DATABASE_URL: "must-not-copy", GH_TOKEN: "must-not-copy", NODE_OPTIONS: "must-not-copy",
    INSTAFY_ENV_DIR: "/private/env", CODEX_HOME: "/private/auth",
    INSTAFY_APP_URL: "https://remote.invalid", INSTAFY_DESKTOP_USER_DATA_DIR: "/private/profile",
    INSTAFY_DESKTOP_PERSONAL_BROWSER: "0", CONTROLLER_URL: "https://remote.invalid",
  };
  const outer = browserCiEnvironment(source);
  assert.deepEqual(outer, {
    ...display, HOME: source.HOME, USERPROFILE: source.USERPROFILE, TMPDIR: source.TMPDIR, CI: "1",
  });
  assert.deepEqual(personalBrowserFixtureEnvironment(outer), display);
  // Direct developer smoke runs must be equally isolated without the CI wrapper.
  assert.deepEqual(personalBrowserFixtureEnvironment(source), display);
  assert.equal(source.INSTAFY_DESKTOP_PERSONAL_BROWSER, "0");
});

test("browser CI rejects filters, reporter overrides, unknown lanes and missing lane", async () => {
  for (const args of [[], ["unknown"], ["constructor"], ["personal", "--grep", "one"],
    ["browser-ui", "--reporter=list"], ["personal", "--pass-with-no-tests"]]) {
    await assert.rejects(runBrowserCi(args), /Usage:/);
  }
});
