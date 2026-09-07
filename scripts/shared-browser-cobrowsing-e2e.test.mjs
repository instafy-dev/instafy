import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixtureEnvironment } from "./shared-browser-cobrowsing-e2e.mjs";

test("co-browsing fixture browser and CLI receive only OS settings and disposable home", () => {
  const source = {
    PATH: "/fixture/bin", SystemRoot: "/fixture/windows", LANG: "en_US.UTF-8",
    HOME: "/private/home", USERPROFILE: "/private/profile", TMPDIR: "/private/tmp",
    GH_TOKEN: "not-copied", OPENAI_API_KEY: "not-copied", DATABASE_URL: "not-copied",
    SUPABASE_SERVICE_ROLE_KEY: "not-copied", INSTAFY_ENV_DIR: "/private/env",
    NODE_OPTIONS: "--require=/not-copied.js", HTTP_PROXY: "https://not-copied.invalid",
    PLAYWRIGHT_BROWSERS_PATH: "/private/cache", INSTAFY_PLAYWRIGHT_CDP_URL: "http://not-copied.invalid",
    INSTAFY_SHARED_BROWSER_APPROVAL_DIR: "/private/approvals",
    DISPLAY: ":private", XAUTHORITY: "/private/xauthority",
  };
  assert.deepEqual(fixtureEnvironment(source, "/owned/fixture"), {
    PATH: source.PATH, SystemRoot: source.SystemRoot, LANG: source.LANG,
    HOME: "/owned/fixture", USERPROFILE: "/owned/fixture",
    TMPDIR: "/owned/fixture", TMP: "/owned/fixture", TEMP: "/owned/fixture", CI: "1",
  });
  assert.equal(source.HOME, "/private/home");
});

test("co-browsing fixture rejects filters and skips rather than producing a partial pass", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cobrowsing-args-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const argument of ["--skip", "--grep=handoff", "--pass-with-no-tests"]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "shared-browser-cobrowsing-e2e.mjs"), argument], {
      env: fixtureEnvironment(process.env, directory), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no filters or skips/);
    assert.equal(result.stdout, "");
  }
});
