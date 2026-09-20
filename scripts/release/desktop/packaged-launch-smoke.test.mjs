import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCleanExit,
  assertLaunchEvidence,
  childEnvironment,
  packagedAppRoot,
  parseArguments,
  requireLaunchableExecutable,
} from "./packaged-launch-smoke.mjs";

const executable = "/tmp/smoke/Instafy.app/Contents/MacOS/Instafy";

test("arguments require an executable and bound the timeout", () => {
  assert.deepEqual(parseArguments(["--executable", executable, "--timeout-ms", "120000"], { RUNNER_TEMP: "/tmp/runner" }), {
    executable,
    timeoutMs: 120000,
    screenshotDir: "/tmp/runner",
    frontendDir: path.join(process.cwd(), "packages", "frontend"),
  });
  assert.equal(parseArguments(["--executable", executable, "--frontend-dir", "/src/packages/frontend"], {}).frontendDir, "/src/packages/frontend");
  assert.equal(parseArguments(["--executable", executable, "--screenshot-dir", "/tmp/s"], {}).screenshotDir, "/tmp/s");
  assert.throws(() => parseArguments([], {}), /--executable is required/u);
  assert.throws(() => parseArguments(["--executable"], {}), /Missing value/u);
  assert.throws(() => parseArguments(["--executable", executable, "--timeout-ms", "5"], {}), /timeout-ms/u);
  assert.throws(() => parseArguments(["--headed", "1"], {}), /Unsupported/u);
});

test("the executable must live inside an app bundle's MacOS directory", () => {
  assert.equal(packagedAppRoot(executable), "/tmp/smoke/Instafy.app");
  assert.throws(() => packagedAppRoot("Instafy.app/Contents/MacOS/Instafy"), /absolute/u);
  assert.throws(() => packagedAppRoot("/tmp/smoke/Instafy"), /Contents\/MacOS/u);
  assert.throws(() => packagedAppRoot("/tmp/smoke/Instafy.app/Contents/Resources/x"), /Contents\/MacOS/u);
});

test("the executable must be a regular executable file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-smoke-"));
  try {
    const binary = path.join(dir, "Instafy.app", "Contents", "MacOS", "Instafy");
    assert.throws(() => requireLaunchableExecutable(binary), /regular executable/u);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "bin", { mode: 0o644 });
    assert.throws(() => requireLaunchableExecutable(binary), /regular executable/u);
    fs.chmodSync(binary, 0o755);
    assert.equal(requireLaunchableExecutable(binary), path.join(dir, "Instafy.app"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch evidence proves the packaged app and a loaded first window", () => {
  const good = { executable, isPackaged: true, exePath: executable, title: " Instafy ", url: "https://prod.instafy.dev/" };
  assert.deepEqual(assertLaunchEvidence(good), { title: "Instafy", url: "https://prod.instafy.dev/" });
  assert.deepEqual(assertLaunchEvidence({ ...good, title: "" }), { title: "", url: "https://prod.instafy.dev/" });
  assert.throws(() => assertLaunchEvidence({ ...good, isPackaged: false }), /isPackaged/u);
  assert.throws(() => assertLaunchEvidence({ ...good, exePath: "/Applications/Instafy.app/Contents/MacOS/Instafy" }), /outside/u);
  assert.throws(() => assertLaunchEvidence({ ...good, title: "  ", url: "about:blank" }), /neither a title/u);
});

test("only a zero exit code is clean and the child environment is allowlisted", () => {
  assert.doesNotThrow(() => assertCleanExit({ code: 0, signal: null }));
  assert.throws(() => assertCleanExit({ code: null, signal: "SIGKILL" }), /SIGKILL/u);
  assert.throws(() => assertCleanExit({ code: 1, signal: null }), /code 1/u);
  const env = childEnvironment({ HOME: "/h", PATH: "/bin", GH_TOKEN: "x", CSC_KEY_PASSWORD: "x" }, "/tmp/profile");
  assert.deepEqual(env, {
    HOME: "/h",
    PATH: "/bin",
    INSTAFY_DESKTOP_USER_DATA_DIR: "/tmp/profile",
    INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
    INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST: "1",
  });
});
