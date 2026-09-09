import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { cargoTestArtifact, chromiumStartupDiagnostics, copyFixtureEntrypoint, fixtureChildEnvironment, fixtureCompilerEnvironment, installCancellationSignalHandlers, preflightFixtureDisplay, runOwnedProcess, validateBrowserFixtureEnvironment, validateFixtureEnvironment } from "./browser-profile-e2e.mjs";

async function diagnosticFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "profile-diagnostics-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = { directory, runId: "00000000-0000-4000-8000-000000000001", fixtureRoot: path.join(directory, "owned-fixture") };
  await mkdir(path.join(directory, "playwright"));
  await writeFile(path.join(directory, "profile-e2e-owner.json"), JSON.stringify({ runId: fixture.runId, root: fixture.fixtureRoot }));
  return { fixture, log: path.join(directory, "playwright/chromium.log") };
}

test("owned startup logs yield only fixed categories, never raw messages, URLs or tokens", async (t) => {
  const { fixture, log } = await diagnosticFixture(t);
  const secret = "fixture-sensitive-value-do-not-retain";
  await writeFile(log, `${secret}\nAuthorization required, but no authorization protocol specified\nMissing X server or $DISPLAY\nThe platform failed to initialize. Exiting.\nFATAL: https://fixture.invalid/${secret}\n`);
  const diagnostic = await chromiumStartupDiagnostics(fixture);
  assert.deepEqual(diagnostic.categories, ["display-unavailable", "display-authorization", "platform-initialization-failed", "fatal-or-signal"]);
  assert.equal(diagnostic.state, "read");
  assert.equal(diagnostic.truncated, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-sensitive|https:|FATAL:|Missing X server/);
  // Unknown errors remain explicitly unclassified, not fabricated diagnoses.
  await writeFile(log, `Unrecognized failure with ${secret}`);
  assert.deepEqual((await chromiumStartupDiagnostics(fixture)).categories, ["unclassified"]);
});

test("startup log categories distinguish resource, dependency, profile, listener and fatal signals", async (t) => {
  const { fixture, log } = await diagnosticFixture(t);
  for (const [message, category] of [
    ["error while loading shared libraries: fixture.so", "missing-system-library"],
    ["Failed to create a ProcessSingleton for your profile directory", "profile-in-use"],
    ["bind() failed: Address already in use (98)", "address-in-use"],
    ["Cannot start http server for devtools", "devtools-listener-failed"],
    ["No space left on device", "resource-exhausted"],
    ["No usable sandbox!", "sandbox-failed"],
    ["chrome_crashpad_handler: --database is required", "crash-handler-failed"],
    ["Received signal 11", "fatal-or-signal"],
    ["DevTools listening on ws://127.0.0.1:9223/devtools/browser/inert-id", "devtools-ready-observed"],
  ]) {
    await writeFile(log, message);
    assert.deepEqual((await chromiumStartupDiagnostics(fixture)).categories, [category]);
  }
});

test("startup diagnostics bound reads to the last 64 KiB and do not retain log content", async (t) => {
  const { fixture, log } = await diagnosticFixture(t);
  await writeFile(log, `FATAL: outside-the-bounded-tail\n${"x".repeat(1024 * 1024)}\nCannot allocate memory`);
  const diagnostic = await chromiumStartupDiagnostics(fixture);
  assert.equal(diagnostic.bytesRead, 64 * 1024);
  assert.equal(diagnostic.truncated, true);
  assert.deepEqual(diagnostic.categories, ["resource-exhausted"]);
  assert.ok(JSON.stringify(diagnostic).length < 256);
});

test("startup diagnostics reject unowned markers, directory links, file links and nonregular logs", async (t) => {
  const { fixture, log } = await diagnosticFixture(t);
  const target = path.join(fixture.directory, "synthetic-log");
  await writeFile(target, "FATAL: must not read through links");
  assert.equal((await chromiumStartupDiagnostics(fixture)).state, "missing");
  assert.equal((await chromiumStartupDiagnostics({ ...fixture, runId: "wrong-owner" })).state, "ownership-unverified");
  await symlink(target, log);
  assert.equal((await chromiumStartupDiagnostics(fixture)).state, "unsafe");
  await rm(log);
  await link(target, log);
  assert.equal((await chromiumStartupDiagnostics(fixture)).state, "unsafe");
  await rm(log);
  await mkdir(log);
  assert.equal((await chromiumStartupDiagnostics(fixture)).state, "unsafe");
  await rm(path.join(fixture.directory, "playwright"), { recursive: true });
  await symlink(fixture.directory, path.join(fixture.directory, "playwright"));
  assert.equal((await chromiumStartupDiagnostics(fixture)).state, "ownership-unverified");
});

test("display preflight uses the scrubbed environment and discards all process output", async () => {
  const env = { PATH: "/fixture/bin", DISPLAY: ":99", XAUTHORITY: "/fixture/Xauthority", TEST_DATABASE_URL: "must-not-copy", NODE_OPTIONS: "must-not-copy", GH_TOKEN: "must-not-copy" };
  for (const [exitCode, expected] of [[0, "ready"], [1, "display-unavailable"]]) {
    assert.equal(await preflightFixtureDisplay(env, { spawnProcess(command, args, options) {
      assert.equal(command, "xdpyinfo");
      assert.deepEqual(args, ["-display", ":99"]);
      assert.deepEqual(options, { env: { PATH: env.PATH, DISPLAY: env.DISPLAY, XAUTHORITY: env.XAUTHORITY }, detached: true, stdio: "ignore" });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exitCode));
      return child;
    } }), expected);
  }
  assert.equal(await preflightFixtureDisplay({}), "display-not-configured");
  assert.equal(await preflightFixtureDisplay(env, { spawnProcess() {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("do-not-retain-error"), { code: "ENOENT" })));
    return child;
  } }), "probe-unavailable");
});

test("display probe timeout and cancellation stop only their owned helper", async () => {
  for (const cancel of [false, true]) {
    const cancellation = new AbortController();
    let pid;
    const status = await preflightFixtureDisplay({ ...fixtureChildEnvironment(process.env), DISPLAY: ":fixture" }, {
      signal: cancellation.signal, timeoutMs: 100,
      spawnProcess(_command, _args, options) {
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
        pid = child.pid;
        if (cancel) queueMicrotask(() => cancellation.abort());
        return child;
      },
    });
    assert.equal(status, cancel ? "cancelled" : "timed-out");
    await assertOwnedProcessStopped(pid);
  }
  const cancellation = new AbortController();
  cancellation.abort();
  assert.equal(await preflightFixtureDisplay({ DISPLAY: ":fixture" }, { signal: cancellation.signal, spawnProcess() { assert.fail("cancelled preflight must not spawn"); } }), "cancelled");
});

test("lifecycle wires display preflight after builds and fixed diagnostics before owned cleanup", async () => {
  const source = await readFile(new URL("./browser-profile-e2e.mjs", import.meta.url), "utf8");
  const controllerBuild = source.indexOf('stage = "build-controller-fixture"');
  const displayProbe = source.indexOf("displayPreflight = await preflightFixtureDisplay(runEnv");
  const browserLifecycle = source.indexOf('stage = "real-browser-lifecycle"');
  const diagnostics = source.indexOf("await chromiumStartupDiagnostics({ runId, fixtureRoot: temporary })");
  const cleanup = source.indexOf("await rm(fixedRuntimeDirectory, { recursive: true })");
  assert.ok(controllerBuild >= 0 && controllerBuild < displayProbe && displayProbe < browserLifecycle);
  assert.ok(browserLifecycle < diagnostics && diagnostics < cleanup);
  assert.ok(source.includes('assert.equal(displayPreflight, "ready", "Shared fixture X-display preflight failed")'));
  assert.ok(source.includes("startupDiagnostics: { displayPreflight, chromiumLog }"));
});

test("profile lifecycle requires explicit Linux loopback fixture and display", () => {
  const fixture = { DISPLAY: ":99", TEST_DATABASE_URL: "postgresql://fixture@127.0.0.1:54322/postgres" };
  assert.doesNotThrow(() => validateFixtureEnvironment(fixture, "linux"));
  assert.throws(() => validateFixtureEnvironment(fixture, "darwin"));
  assert.throws(() => validateFixtureEnvironment({}, "linux"));
  for (const url of ["postgresql://fixture@prod.example:5432/postgres", "postgresql://fixture@localhost:54322/postgres", "postgresql://fixture@127.0.0.1/postgres", "postgresql://fixture@127.0.0.1:54322/postgres?host=prod.example"]) {
    assert.throws(() => validateFixtureEnvironment({ ...fixture, TEST_DATABASE_URL: url }, "linux"));
  }
});

test("fixture child environment never inherits credentials or policy overrides", () => {
  assert.deepEqual(fixtureChildEnvironment({ PATH: "/bin", HOME: "/tmp/inert", OPENAI_API_KEY: "must-not-copy", DATABASE_URL: "must-not-copy", INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV: "1", INSTAFY_ENV_DIR: "/private" }), { PATH: "/bin", HOME: "/tmp/inert" });
});

const compilerProxyFixture = () => ({ PATH: "/bin", HOME: "/tmp/inert", CARGO_BUILD_JOBS: "2",
  CI: "true", GITHUB_ACTIONS: "true", INSTAFY_CI_JOB_ISOLATION: "ephemeral", INSTAFY_SHARED_BROWSER_COMPILER_PROXY: "1",
  HTTP_PROXY: "http://proxy.example:3128", HTTPS_PROXY: "https://proxy.example:8443",
  http_proxy: "http://must-not-copy.invalid", https_proxy: "http://must-not-copy.invalid", NO_PROXY: "*", ALL_PROXY: "must-not-copy",
  GH_TOKEN: "must-not-copy", NODE_OPTIONS: "must-not-copy", NODE_TLS_REJECT_UNAUTHORIZED: "0", CARGO_HTTP_SSL_VERIFY: "false",
  DATABASE_URL: "must-not-copy", INSTAFY_ENV_DIR: "/private", INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV: "1" });

test("compiler proxy is explicitly gated and copies only validated origins with derived tool aliases", () => {
  const source = compilerProxyFixture(), before = structuredClone(source);
  const ordinary = { PATH: source.PATH, HOME: source.HOME, CARGO_BUILD_JOBS: "2" };
  for (const toggle of [undefined, "", "0"]) assert.deepEqual(fixtureCompilerEnvironment({ ...source, INSTAFY_SHARED_BROWSER_COMPILER_PROXY: toggle }), ordinary);
  assert.deepEqual(fixtureCompilerEnvironment(source), { ...ordinary,
    HTTP_PROXY: source.HTTP_PROXY, http_proxy: source.HTTP_PROXY, HTTPS_PROXY: source.HTTPS_PROXY, https_proxy: source.HTTPS_PROXY });
  assert.deepEqual(fixtureChildEnvironment(source), ordinary, "runtime and browser environments stay proxy-free even when compilation opts in");
  assert.deepEqual(source, before);
  for (const patch of [{ INSTAFY_SHARED_BROWSER_COMPILER_PROXY: "true" }, { CI: "false" }, { GITHUB_ACTIONS: undefined },
    { INSTAFY_CI_JOB_ISOLATION: undefined }, { HTTP_PROXY: undefined }, { HTTPS_PROXY: undefined }]) {
    assert.throws(() => fixtureCompilerEnvironment({ ...source, ...patch }));
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY"]) for (const value of ["", "invalid", "socks5://proxy.example:1080",
    "http://user:inert-secret@proxy.example", "http://proxy.example/path", "http://proxy.example?override=1",
    "http://proxy.example#override", "http://proxy.example/\n", "http://" + "a".repeat(2048)]) {
    assert.throws(() => fixtureCompilerEnvironment({ ...source, [key]: value }), error => {
      assert.equal(error.message, "credential-free compiler proxy origin required");
      if (value) assert.ok(!error.message.includes(value)); return true;
    });
  }
});

test("only the six real Go and Cargo build callsites use the explicit compiler environment", async () => {
  for (const file of ["browser-profile-e2e.mjs", "shared-browser-studio-e2e.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /const compilerEnv = fixtureCompilerEnvironment\(process\.env\);/);
    assert.equal((source.match(/env: compilerEnv/g) ?? []).length, 3);
    assert.equal((source.match(/await run\("(?:go|cargo)",[^\n]+env: compilerEnv/g) ?? []).length, 3);
    assert.doesNotMatch(source, /\.\.\.compilerEnv|studioProcessEnvironment\(compilerEnv|preflightFixtureDisplay\(compilerEnv/);
  }
});

test("a real compiler-shaped child receives no credentials, policy overrides or proxy bypass environment", async () => {
  const env = fixtureCompilerEnvironment({ ...compilerProxyFixture(), PATH: process.env.PATH });
  const output = await runOwnedProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env, timeoutMs: 5_000 });
  const observed = JSON.parse(output);
  // macOS adds this text-encoding marker at process startup, independently of
  // the explicitly supplied environment. Linux CI does not receive it.
  if (process.platform === "darwin") delete observed.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(observed, env);
});

test("native fixture copies identical entrypoint bytes with executable mode without modifying the checkout", async () => {
  const source = new URL("../docker/runtime/entrypoint.sh", import.meta.url);
  const originalMode = (await stat(source)).mode;
  const owned = await mkdtemp(path.join(tmpdir(), "profile-entrypoint-test-"));
  try {
    const destination = await copyFixtureEntrypoint(owned);
    assert.equal(path.dirname(destination), owned);
    assert.deepEqual(await readFile(destination), await readFile(source));
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal((await stat(source)).mode, originalMode);
    await assert.rejects(copyFixtureEntrypoint(owned), { code: "EEXIST" });
  } finally {
    await rm(owned, { recursive: true });
  }
  await assert.rejects(stat(owned), { code: "ENOENT" });
});

test("browser helper rejects missing marker, arbitrary ports and unowned profile paths before connecting", () => {
  const fixture = { INSTAFY_PROFILE_E2E: "1", INSTAFY_PROFILE_E2E_RUN_ID: "00000000-0000-0000-0000-000000000000", INSTAFY_PROFILE_E2E_ROOT: "/tmp/inert-profile-fixture", INSTAFY_PLAYWRIGHT_PROFILE_DIR: "/tmp/inert-profile-fixture/profile", INSTAFY_PLAYWRIGHT_CDP_PORT: "9223" };
  assert.doesNotThrow(() => validateBrowserFixtureEnvironment(fixture, "linux"));
  assert.throws(() => validateBrowserFixtureEnvironment({}, "linux"), /fixture marker/);
  assert.throws(() => validateBrowserFixtureEnvironment({ ...fixture, INSTAFY_PLAYWRIGHT_CDP_PORT: "9223/elsewhere" }, "linux"));
  assert.throws(() => validateBrowserFixtureEnvironment({ ...fixture, INSTAFY_PLAYWRIGHT_CDP_PORT: "65536" }, "linux"));
  assert.throws(() => validateBrowserFixtureEnvironment({ ...fixture, INSTAFY_PLAYWRIGHT_PROFILE_DIR: "/tmp/unrelated-profile" }, "linux"));
});

test("exact compiled executable is required; zero/ambiguous test discovery fails", () => {
  const artifact = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, target: { name: "browser_profile_e2e", kind: ["test"] }, executable: "/tmp/inert-test" });
  assert.equal(cargoTestArtifact(artifact, "browser_profile_e2e", "test"), "/tmp/inert-test");
  assert.throws(() => cargoTestArtifact("", "browser_profile_e2e", "test"));
  assert.throws(() => cargoTestArtifact(`${artifact}\n${artifact}`, "browser_profile_e2e", "test"));
  assert.throws(() => cargoTestArtifact(artifact, "different", "test"));
});

test("SIGINT and SIGTERM cancel the fixture and their handlers are removed", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const emitter = new EventEmitter();
    const cancellation = new AbortController();
    const remove = installCancellationSignalHandlers(cancellation, emitter);
    emitter.emit(signal);
    assert.equal(cancellation.signal.aborted, true);
    remove();
    assert.equal(emitter.listenerCount("SIGINT"), 0);
    assert.equal(emitter.listenerCount("SIGTERM"), 0);
  }
});

async function assertOwnedProcessStopped(pid, { kill = process.kill, read = readFile, platform = process.platform } = {}) {
  for (let retry = 0; retry < 50; retry++) {
    try { kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
    if (platform === "linux") {
      try {
        const stat = await read(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 1).trimStart().startsWith("Z")) return;
      } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return; throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("owned disposable process survived cancellation/cleanup");
}

test("stopped-process proof accepts procfs exit races but rejects inaccessible live evidence", async () => {
  // Linux can reap the process after kill(0) succeeds or after /proc/stat opens.
  // The latter makes read(2) return ESRCH instead of open(2)'s ENOENT.
  const probe = code => assertOwnedProcessStopped(123, { platform: "linux", kill() {},
    read: async () => { throw Object.assign(new Error("fixture read"), { code }); } });
  await probe("ENOENT");
  await probe("ESRCH");
  await assert.rejects(probe("EACCES"), { code: "EACCES" });
});

test("cancellation stops the owned build/test process group and descendants", async () => {
  const cancellation = new AbortController();
  let output = "";
  let ids;
  const helper = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);";
  await assert.rejects(runOwnedProcess(process.execPath, ["-e", helper], {
    env: fixtureChildEnvironment(process.env), signal: cancellation.signal, timeoutMs: 5_000,
    onOutput(data) {
      output += data;
      if (output.includes("\n")) { ids = JSON.parse(output.trim()); cancellation.abort(); }
    },
  }), { name: "AbortError" });
  assert.equal(ids.length, 2);
  for (const pid of ids) await assertOwnedProcessStopped(pid);
});

test("successful parent exit also cleans its owned orphan helper", async () => {
  const helper = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();";
  const output = await runOwnedProcess(process.execPath, ["-e", helper], {
    env: fixtureChildEnvironment(process.env), timeoutMs: 5_000,
  });
  await assertOwnedProcessStopped(Number(output.trim()));
});
