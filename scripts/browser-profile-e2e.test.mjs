import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTestArtifact, chromiumStartupDiagnostics, copyFixtureEntrypoint, fixtureChildEnvironment, fixtureCompilerEnvironment, fixtureCargoEnvironment, installCancellationSignalHandlers, preflightFixtureDisplay, reportCargoCompilerErrors, runOwnedProcess, validateBrowserFixtureEnvironment, validateFixtureEnvironment } from "./browser-profile-e2e.mjs";

const agentManifest = fileURLToPath(new URL("../packages/runtime-agent/Cargo.toml", import.meta.url));
const compilerError = (patch = {}) => JSON.stringify({ reason: "compiler-message", manifest_path: agentManifest, message: {
  level: "error", rendered: "error[E0063]: missing field `fixture_field` in initializer of `Config`\n --> packages/runtime-agent/tests/browser_profile_e2e.rs:27:3\n  | source snippet must not be printed\n",
  spans: [{ is_primary: true, file_name: "tests/browser_profile_e2e.rs", line_start: 27, column_start: 3,
    text: [{ text: "private source snippet" }], label: "private label" }], ...patch,
} });
const compilerReport = (output, crate = "packages/runtime-agent") => { let text = ""; reportCargoCompilerErrors(output, crate, part => { text += part; }); return text; };

test("compiler diagnostics select only error headings and source locations, not Cargo or child stdout", () => {
  const output = ["private arbitrary stdout", "{malformed private data", "null", "42",
    JSON.stringify({ reason: "build-script-executed", env: [["PRIVATE_TOKEN", "must-not-print"]] }),
    JSON.stringify({ reason: "compiler-artifact", executable: "/private/artifact", message: { level: "error", rendered: "error: private artifact" } }),
    compilerError({ level: "warning", rendered: "warning: private warning" }), compilerError()].join("\n");
  assert.equal(compilerReport(output), "[cargo-compiler] error[E0063]: missing field [quoted] in initializer of [quoted]\n"
    + "[cargo-compiler] categories=none; notes=absent\n"
    + "[cargo-compiler] at packages/runtime-agent/tests/browser_profile_e2e.rs:27:3\n");
});

test("compiler errors redact payloads and never print rendered source, notes, linker argv or terminal commands", () => {
  const rendered = "\u001b[31merror: linking with `private-linker` failed: exit status: 1\u001b[0m\n"
    + "  = note: PRIVATE_TOKEN=must-not-print /private/toolchain https://user:password@private.invalid\n"
    + "  = note: ::warning::must-not-print\n";
  assert.equal(compilerReport(compilerError({ rendered })), "[cargo-compiler] error: linking with [quoted] failed: exit status: 1\n"
    + "[cargo-compiler] categories=linker-failed; notes=absent\n"
    + "[cargo-compiler] at packages/runtime-agent/tests/browser_profile_e2e.rs:27:3\n");
  for (const rendered of ["error: PRIVATE_TOKEN=must-not-print", "error: Authorization Bearer must-not-print", "error: password must-not-print"]) {
    assert.match(compilerReport(compilerError({ rendered })), /error: \[sensitive heading omitted\]/);
    assert.doesNotMatch(compilerReport(compilerError({ rendered })), /must-not-print|Bearer/);
  }
  const result = compilerReport(compilerError({ rendered: 'error: failed "private value" at https://user:inert@private.invalid/file /private/file abcdefghijklmnopqrstuvwxyz1234' }));
  assert.match(result, /failed \[quoted\] at \[url\] \[path\] \[opaque\]/);
  assert.doesNotMatch(result, /private value|user:|inert|private.invalid|private\/file|abcdefghijklmnopqrstuvwxyz/);
});

const linkerDiagnostic = children => compilerError({ rendered: "error: linking with `cc` failed: exit status: 1\n", children });
const compilerNote = message => ({ level: "note", message, children: [], spans: [] });

test("compiler child notes yield fixed categories for known linker failures, never the matched text", () => {
  const result = compilerReport(linkerDiagnostic([
    compilerNote("collect2: fatal error: ld terminated with signal 9 [Killed]"),
    compilerNote("/usr/bin/ld: cannot find -linert_private_library: No such file or directory"),
    compilerNote("ld.lld: error: undefined symbol: inert_private_symbol"),
    compilerNote("LLVM ERROR: IO failure on output stream: No space left on device"),
    compilerNote("memory allocation of 123456 bytes failed"),
  ]));
  assert.match(result, /categories=allocation-failed,disk-full,linker-failed,linker-killed,missing-library,undefined-symbol; notes=matched/);
  assert.doesNotMatch(result, /inert_private|collect2|\/usr\/bin|123456|LLVM|signal 9|\[Killed\]|OOM|out.of.memory/i);
  for (const [message, category] of [
    ["ld.lld: error: unable to find library -linert", "missing-library"],
    ["ld: library not found for -linert", "missing-library"],
    ["/fixture/lib.o:(.text+0x17): undefined reference to `inert_symbol'", "undefined-symbol"],
    ["Undefined symbols for architecture arm64:", "undefined-symbol"],
    ["ld: final link failed: No space left on device", "disk-full"],
    ["ld.lld: error: Cannot allocate memory", "allocation-failed"],
  ]) assert.match(compilerReport(linkerDiagnostic([compilerNote(message)])), new RegExp(`categories=[^\\n]*${category}[^\\n]*; notes=matched`));
});

test("missing and unrecognized compiler note evidence stays explicit without inventing a cause", () => {
  for (const children of [undefined, null, []]) assert.match(compilerReport(linkerDiagnostic(children)), /categories=linker-failed; notes=absent/);
  for (const message of ["unrecognized diagnostic", "collect2: fatal error: ld terminated with signal 15", "Killed", "possible OOM", "ordinary help text"]) {
    assert.match(compilerReport(linkerDiagnostic([compilerNote(message)])), /categories=linker-failed; notes=unclassified/);
  }
  assert.match(compilerReport(linkerDiagnostic({ message: "not an array" })), /notes=invalid/);
  assert.match(compilerReport(linkerDiagnostic([compilerNote("linking with `cc` failed: exit status: 1")])),
    /categories=linker-failed; notes=matched/, "a matching note is classified even if its category was already observed in the heading");
});

test("note classifier ignores credential, URL, command, source and malformed or recursive payloads", () => {
  for (const message of [
    "PRIVATE_TOKEN=fixture ld.lld: error: undefined symbol: private_symbol",
    "Authorization: Bearer fixture\nhttps://private.invalid/ld: cannot find -linert",
    '"cc" "-Wl,undefined symbol: private_symbol"',
    "::warning:: undefined reference to `private_symbol'",
    "12 | undefined reference to `private_symbol'",
    "ld: cannot find -ltoken_value", "ld: cannot find -linert https://private.invalid/value",
  ]) {
    const output = compilerReport(linkerDiagnostic([compilerNote(message)]));
    assert.match(output, /categories=linker-failed; notes=unclassified/);
    assert.doesNotMatch(output, /PRIVATE_TOKEN|private_symbol|Bearer|private.invalid|token_value/);
  }
  const nested = { ...compilerNote("unknown parent"), children: [compilerNote("ld: Cannot allocate memory")] };
  for (const children of [[nested], [null], [{ level: "note", message: {} }], [{ ...compilerNote("unknown"), children: {} }]]) {
    assert.match(compilerReport(linkerDiagnostic(children)), /categories=linker-failed; notes=invalid/);
  }
  const ignored = { level: "help", message: "ld: Cannot allocate memory", spans: [{ text: [{ text: "ld: Cannot allocate memory" }] }] };
  assert.match(compilerReport(linkerDiagnostic([ignored])), /categories=linker-failed; notes=unclassified/);
  assert.equal(compilerReport(compilerError({ level: "warning", children: [compilerNote("ld: Cannot allocate memory")] })), "");
});

test("compiler note count, UTF-8 bytes, lines, line size and total output are bounded", () => {
  const cause = compilerNote("ld: Cannot allocate memory");
  for (const children of [
    [...Array(16).fill(compilerNote("unknown")), cause],
    [compilerNote("界".repeat(22_000) + "\nld: Cannot allocate memory")],
    [compilerNote("unknown\n".repeat(128) + "ld: Cannot allocate memory")],
    [compilerNote("ld: Cannot allocate memory" + " ".repeat(2048))],
  ]) assert.match(compilerReport(linkerDiagnostic(children)), /categories=linker-failed; notes=limited/);
  const many = Array(100).fill(linkerDiagnostic([cause])).join("\n");
  const output = compilerReport(many);
  assert.equal((output.match(/categories=/g) ?? []).length, 8);
  assert.ok(Buffer.byteLength(output) < 8 * 1024);
  assert.match(output, /diagnostic limit reached \(8 errors\)/);
  assert.equal(compilerReport(linkerDiagnostic([compilerNote("x".repeat(256 * 1024))])), "", "the existing whole-record byte limit applies before notes");
});

test("compiler diagnostics refuse malformed locations and unknown rendered formats", () => {
  for (const file_name of ["/private/source.rs", "../private.rs", "src/../private.rs", "src/./private.rs", "src//file.rs", "https://private.invalid/file.rs", "src/private\n::warning::.rs", "C:\\private\\source.rs", "C:/private/source.rs", "src\\file.rs"]) {
    const result = compilerReport(compilerError({ spans: [{ is_primary: true, file_name, line_start: 1, column_start: 1 }] }));
    assert.doesNotMatch(result, /\[cargo-compiler\] at /);
  }
  for (const patch of [{ spans: {} }, { spans: [null] }, { spans: [{ is_primary: true, file_name: "packages/test.rs", line_start: -1, column_start: 1 }] }]) {
    assert.doesNotMatch(compilerReport(compilerError(patch)), /\[cargo-compiler\] at /);
  }
  for (const patch of [{ rendered: null }, { rendered: "private output\nerror: too late" }, { rendered: "::warning::private data" }, { level: "note" }]) {
    assert.equal(compilerReport(compilerError(patch)), "");
  }
});

test("crate-relative locations bind the fixed Cargo callsite and exact manifest, never a dependency or override", () => {
  const record = JSON.parse(compilerError({ spans: [{ is_primary: true, file_name: "src/main.rs", line_start: 100, column_start: 8 }] }));
  record.manifest_path = fileURLToPath(new URL("../packages/runtime-controller/Cargo.toml", import.meta.url));
  assert.match(compilerReport(JSON.stringify(record), "packages/runtime-controller"), /at packages\/runtime-controller\/src\/main.rs:100:8/);
  assert.doesNotMatch(compilerReport(JSON.stringify(record)), /\[cargo-compiler\] at /);
  for (const manifest of [undefined, "/private/dependency/Cargo.toml", agentManifest + "/../Cargo.toml"]) {
    assert.doesNotMatch(compilerReport(JSON.stringify({ ...record, manifest_path: manifest })), /\[cargo-compiler\] at /);
  }
  for (const crate of [undefined, "packages/other", "packages/../private", "/private", "packages\\runtime-agent"]) {
    assert.throws(() => reportCargoCompilerErrors(compilerError(), crate), /fixed fixture compiler crate required/);
  }
});

test("compiler diagnostic input records, headings and aggregate output remain bounded", () => {
  const oversized = compilerError({ rendered: "error: " + "x".repeat(256 * 1024) });
  assert.equal(compilerReport(oversized + "\n" + compilerError()), compilerReport(compilerError()));
  const multibyte = compilerError({ rendered: "error: " + "界".repeat(100_000) });
  assert.ok(multibyte.length < 256 * 1024 && Buffer.byteLength(multibyte) > 256 * 1024);
  assert.equal(compilerReport(multibyte + "\n" + compilerError()), compilerReport(compilerError()));
  const text = compilerReport(Array(100).fill(compilerError({ rendered: "error: " + "word ".repeat(1000) })).join("\n"));
  assert.equal((text.match(/\[cargo-compiler\] error:/g) ?? []).length, 8);
  assert.match(text, /diagnostic limit reached \(8 errors\)/);
  assert.ok(Buffer.byteLength(text) < 8 * 1024);
  assert.ok(text.split("\n").every(line => line.length <= 530));
});

test("a failed compiler-shaped process reports once but retains its nonzero failure", async () => {
  let diagnostics = "", calls = 0;
  await assert.rejects(runOwnedProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1],()=>process.exit(1))", compilerError()], {
    env: fixtureChildEnvironment(process.env), timeoutMs: 5_000,
    onFailure(output) { calls++; reportCargoCompilerErrors(output, "packages/runtime-agent", text => { diagnostics += text; }); },
  }), error => { assert.match(error.message, /failed/); assert.equal(error.actual, 1); return true; });
  assert.equal(calls, 1);
  assert.match(diagnostics, /error\[E0063\]: missing field/);
  assert.match(diagnostics, /browser_profile_e2e.rs:27:3/);
  assert.doesNotMatch(diagnostics, /private|snippet|fixture_field/);
});

test("successful compiler output and artifact selection remain unchanged; generic failures disclose no stdout", async () => {
  const artifact = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, target: { name: "browser_profile_e2e", kind: ["test"] }, executable: "/tmp/inert-test" });
  const result = await runOwnedProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", artifact], {
    env: fixtureChildEnvironment(process.env), timeoutMs: 5_000, onFailure() { assert.fail("success cannot report failure"); },
  });
  assert.equal(result, artifact);
  assert.equal(cargoTestArtifact(result, "browser_profile_e2e", "test"), "/tmp/inert-test");
  await assert.rejects(runOwnedProcess(process.execPath, ["-e", "process.stdout.write('private-child-output',()=>process.exit(1))"], {
    env: fixtureChildEnvironment(process.env), timeoutMs: 5_000,
  }), error => { assert.doesNotMatch(error.message, /private-child-output/); return true; });
});

test("only four fixed JSON Cargo compilation calls opt into failure diagnostics", async () => {
  for (const file of ["browser-profile-e2e.mjs", "shared-browser-studio-e2e.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.equal((source.match(/onFailure: output => reportCargoCompilerErrors/g) ?? []).length, 2);
    for (const crate of ["runtime-agent", "runtime-controller"]) {
      const line = source.split("\n").find(line => line.includes('await run("cargo"') && line.includes(`"packages/${crate}/Cargo.toml"`));
      assert.ok(line.includes(`"--message-format=json"], { env: cargoEnv, onFailure: output => reportCargoCompilerErrors(output, "packages/${crate}") }`));
    }
  }
});

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

test("Cargo defaults to LLD only on Linux with unset RUSTFLAGS and preserves explicit choices", () => {
  const source = { PATH: "/bin", CARGO_BUILD_JOBS: "2", RUSTFLAGS: undefined }, before = structuredClone(source);
  assert.deepEqual(fixtureCargoEnvironment(source, "linux"), { PATH: "/bin", CARGO_BUILD_JOBS: "2", RUSTFLAGS: "-C link-arg=-fuse-ld=lld" });
  assert.deepEqual(fixtureCargoEnvironment({}, "linux"), { RUSTFLAGS: "-C link-arg=-fuse-ld=lld" });
  for (const platform of ["darwin", "win32", "freebsd"]) assert.deepEqual(fixtureCargoEnvironment(source, platform), fixtureCompilerEnvironment(source));
  for (const value of ["", " ", "-C debuginfo=0", "-C linker=clang -C link-arg=-fuse-ld=gold", "--cfg=fixture\n-C opt-level=1"]) {
    for (const platform of ["linux", "darwin", "win32"]) assert.deepEqual(fixtureCargoEnvironment({ ...source, RUSTFLAGS: value }, platform), { PATH: "/bin", CARGO_BUILD_JOBS: "2", RUSTFLAGS: value });
  }
  assert.deepEqual(fixtureCompilerEnvironment(source), { PATH: "/bin", CARGO_BUILD_JOBS: "2" }, "Go retains the original environment");
  assert.deepEqual(source, before);
});

test("a real Cargo-shaped child retains only the existing compiler allowlist plus the fixed default", async () => {
  const source = { ...compilerProxyFixture(), PATH: process.env.PATH, CARGO_ENCODED_RUSTFLAGS: "must-not-copy", CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "must-not-copy", CC: "must-not-copy", LD: "must-not-copy" };
  const before = structuredClone(source), env = fixtureCargoEnvironment(source, "linux");
  assert.deepEqual(env, { ...fixtureCompilerEnvironment(source), RUSTFLAGS: "-C link-arg=-fuse-ld=lld" });
  const observed = JSON.parse(await runOwnedProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env, timeoutMs: 5_000 }));
  if (process.platform === "darwin") delete observed.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(observed, env);
  assert.deepEqual(source, before);
  assert.throws(() => fixtureCargoEnvironment({ ...source, HTTPS_PROXY: "https://user:inert-secret@proxy.example" }, "linux"), /credential-free compiler proxy origin required/);
});

test("only four Cargo builds use the Cargo default and two Go builds retain the compiler environment", async () => {
  for (const file of ["browser-profile-e2e.mjs", "shared-browser-studio-e2e.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /const compilerEnv = fixtureCompilerEnvironment\(process\.env\);/);
    assert.match(source, /const cargoEnv = fixtureCargoEnvironment\(process\.env\);/);
    assert.equal((source.match(/env: compilerEnv/g) ?? []).length, 1);
    assert.equal((source.match(/await run\("go",[^\n]+env: compilerEnv/g) ?? []).length, 1);
    assert.equal((source.match(/env: cargoEnv/g) ?? []).length, 2);
    assert.equal((source.match(/await run\("cargo",[^\n]+env: cargoEnv/g) ?? []).length, 2);
    assert.doesNotMatch(source, /\.\.\.(?:compilerEnv|cargoEnv)|studioProcessEnvironment\((?:compilerEnv|cargoEnv)|preflightFixtureDisplay\((?:compilerEnv|cargoEnv)/);
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
