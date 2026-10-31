import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixtureEnvironment, policyScriptNames } from "./shared-browser-cobrowsing-e2e.mjs";

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

test("co-browsing fixture embeds the same policy scripts, in the same order, as the runtime agent", () => {
  const rust = fs.readFileSync(
    path.join(import.meta.dirname, "../packages/runtime-agent/src/shared_browser.rs"),
    "utf8",
  );
  const files = new Map(
    Array.from(
      rust.matchAll(/const (BROWSER_\w+_SCRIPT): &str =\s*include_str!\("\.\.\/\.\.\/browser-action-policy\/([\w.]+)"\);/gu),
      ([, name, file]) => [name, file],
    ),
  );
  const body = rust.match(/fn embedded_shared_browser_script\(\) -> String \{([\s\S]*?)\n\}/u);
  assert.ok(body, "embedded_shared_browser_script() not found");
  const embedded = Array.from(body[1].matchAll(/embedded_plain_script\((BROWSER_\w+_SCRIPT)\)/gu), ([, name]) => {
    assert.ok(files.has(name), name);
    return files.get(name);
  });
  assert.ok(embedded.length > 0);
  assert.deepEqual(policyScriptNames, embedded);
});

// Octo's own tabs: scripts/shared-browser-agent-tabs-e2e.mjs, which the
// co-browsing fixture's CI step runs after its own proof.

test("agent-tabs fixture rejects filters and skips rather than producing a partial pass", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-agent-tabs-args-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const argument of ["--skip", "--grep=tabs", "--pass-with-no-tests"]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "shared-browser-agent-tabs-e2e.mjs"), argument], {
      env: fixtureEnvironment(process.env, directory), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no filters or skips/);
    assert.equal(result.stdout, "");
  }
});

test("form-submission fixture rejects filters and skips rather than producing a partial pass", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-form-submission-args-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const argument of ["--skip", "--grep=forms", "--pass-with-no-tests"]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "shared-browser-form-submission-e2e.mjs"), argument], {
      env: fixtureEnvironment(process.env, directory), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no filters or skips/);
    assert.equal(result.stdout, "");
  }
});

test("step-time fixture rejects filters and skips rather than producing a partial pass", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-step-time-args-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const argument of ["--skip", "--grep=time", "--pass-with-no-tests"]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "shared-browser-step-time-e2e.mjs"), argument], {
      env: fixtureEnvironment(process.env, directory), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no filters or skips/);
    assert.equal(result.stdout, "");
  }
});

test("sign-in fixture rejects filters and skips rather than producing a partial pass", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-sign-in-args-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const argument of ["--skip", "--grep=sign-in", "--pass-with-no-tests"]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "shared-browser-sign-in-e2e.mjs"), argument], {
      env: fixtureEnvironment(process.env, directory), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no filters or skips/);
    assert.equal(result.stdout, "");
  }
});

test("allowed-step fixture rejects filters and skips rather than producing a partial pass", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-allowed-step-args-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const argument of ["--skip", "--grep=allow", "--pass-with-no-tests"]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "shared-browser-allowed-step-e2e.mjs"), argument], {
      env: fixtureEnvironment(process.env, directory), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no filters or skips/);
    assert.equal(result.stdout, "");
  }
});

test("every fixture embeds the link-only list the runtime agent embeds, ahead of the controller", () => {
  const rust = fs.readFileSync(
    path.join(import.meta.dirname, "../packages/runtime-agent/src/shared_browser.rs"),
    "utf8",
  );
  const file = rust.match(/const LINK_ONLY_SITES_DATA: &str = include_str!\(\s*"\.\.\/assets\/([^"]+)"\s*\);/u);
  assert.ok(file, "runtime-agent embeds the link-only list");
  assert.match(rust, /globalThis\.__instafyLinkOnlySites = \{LINK_ONLY_SITES_DATA\};/u);
  // The controller refuses every step, in any tab, without the list.
  for (const name of ["shared-browser-agent-tabs-e2e.mjs", "shared-browser-allowed-step-e2e.mjs", "shared-browser-cobrowsing-e2e.mjs", "shared-browser-form-submission-e2e.mjs", "shared-browser-sign-in-e2e.mjs", "shared-browser-step-time-e2e.mjs"]) {
    const fixture = fs.readFileSync(path.join(import.meta.dirname, name), "utf8");
    assert.ok(fixture.includes(`"packages/runtime-agent/assets/${file[1]}"`), `${name}: ${file[1]}`);
    assert.match(fixture, /`globalThis\.__instafyLinkOnlySites = \$\{linkOnlySites\};`/u, name);
  }
  const order = rust.match(/fn embedded_shared_browser_script\(\) -> String \{([\s\S]*?)\n\}/u)[1];
  assert.ok(order.indexOf("embedded_link_only_sites()") > order.indexOf("BROWSER_PAGE_CAPTURE_SCRIPT"));
});

test("the co-browsing fixture's CI step also runs the agent-tabs, form-submission, step-time, sign-in and allowed-step fixtures", () => {
  const runner = fs.readFileSync(path.join(import.meta.dirname, "shared-browser-cobrowsing-e2e.mjs"), "utf8");
  assert.match(runner, /await import\("\.\/shared-browser-agent-tabs-e2e\.mjs"\)/u);
  assert.match(runner, /await runSharedBrowserAgentTabsFixture\(\)/u);
  assert.match(runner, /await import\("\.\/shared-browser-form-submission-e2e\.mjs"\)/u);
  assert.match(runner, /await runSharedBrowserFormSubmissionFixture\(\)/u);
  assert.match(runner, /await import\("\.\/shared-browser-step-time-e2e\.mjs"\)/u);
  assert.match(runner, /await runSharedBrowserStepTimeFixture\(\)/u);
  assert.match(runner, /await import\("\.\/shared-browser-sign-in-e2e\.mjs"\)/u);
  assert.match(runner, /await runSharedBrowserSignInFixture\(\)/u);
  assert.match(runner, /await import\("\.\/shared-browser-allowed-step-e2e\.mjs"\)/u);
  assert.match(runner, /await runSharedBrowserAllowedStepFixture\(\)/u);
});
