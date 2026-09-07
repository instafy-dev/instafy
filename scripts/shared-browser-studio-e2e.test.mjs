import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cargoBinaryArtifact, closeStudioConnections, createStudioGenerationBridge, fixtureHTML, fixtureOrigin, startDaemon,
  resolvePlaywrightChromiumExecutable, studioProcessEnvironment, validateStudioStack,
  viteCliPath } from "./shared-browser-studio-e2e.mjs";
import { fixtureChildEnvironment } from "./browser-profile-e2e.mjs";

const jwt = claims => `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const localStack = () => ({
  API_URL: "http://127.0.0.1:54321", DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  ANON_KEY: jwt({ iss: "supabase-demo", role: "anon" }),
  SERVICE_ROLE_KEY: jwt({ iss: "supabase-demo", role: "service_role" }), JWT_SECRET: "inert-local-fixture",
});

test("Studio stack guard requires explicit Linux loopback endpoints and local JWT roles", () => {
  assert.doesNotThrow(() => validateStudioStack(localStack(), "linux"));
  assert.throws(() => validateStudioStack(localStack(), "darwin"));
  for (const change of [
    { API_URL: "https://remote.invalid" }, { API_URL: "http://localhost:54321" },
    { API_URL: "http://127.0.0.1" }, { API_URL: "http://user:password@127.0.0.1:54321" },
    { API_URL: "http://127.0.0.1:54321/path" }, { API_URL: "http://127.0.0.1:54321?elsewhere" },
    { DB_URL: "postgresql://postgres:postgres@remote.invalid:54322/postgres" },
    { DB_URL: "postgresql://postgres:postgres@localhost:54322/postgres" },
    { DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=remote.invalid" },
    { DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres#override" },
    { SERVICE_ROLE_KEY: "opaque-nonlocal-or-invalid-key" }, { ANON_KEY: "invalid-key" },
    { SERVICE_ROLE_KEY: jwt({ iss: "supabase", role: "service_role" }) },
    { SERVICE_ROLE_KEY: jwt({ iss: "supabase-demo", role: "anon" }) },
    { ANON_KEY: jwt({ iss: "supabase-demo", role: "service_role" }) },
    { ANON_KEY: jwt({ iss: "supabase-demo", role: "anon", ref: "hosted-project" }) },
    { JWT_SECRET: "" },
  ]) assert.throws(() => validateStudioStack({ ...localStack(), ...change }, "linux"));
});

test("Studio process environment replaces user homes and excludes credentials and launch overrides", () => {
  const source = { PATH: "/fixture/bin", HOME: "/operator/home", DISPLAY: ":99", XAUTHORITY: "/fixture/Xauthority",
    CARGO_HOME: "/operator/cargo", RUSTUP_HOME: "/operator/rust", CARGO_TARGET_DIR: "/operator/build",
    RUSTC: "/untrusted/rustc", RUSTFLAGS: "--fixture", RUSTDOCFLAGS: "--fixture", NODE_OPTIONS: "--require=/untrusted.js",
    CODEX_HOME: "/operator/codex", INSTAFY_ENV_DIR: "/operator/private", GH_TOKEN: "must-not-copy",
    OPENAI_API_KEY: "must-not-copy", SUPABASE_SERVICE_ROLE_KEY: "must-not-copy", DATABASE_URL: "must-not-copy",
    CONTROLLER_URL: "https://remote.invalid", HTTP_PROXY: "http://remote.invalid", VITE_SUPABASE_URL: "https://remote.invalid",
    PLAYWRIGHT_BROWSERS_PATH: "/operator/browser-cache" };
  assert.deepEqual(studioProcessEnvironment(source, "/fixture/home"), {
    PATH: source.PATH, HOME: "/fixture/home", DISPLAY: source.DISPLAY, XAUTHORITY: source.XAUTHORITY,
    CODEX_HOME: "/fixture/home/.codex", INSTAFY_ENV_DIR: "/fixture/home/empty-env", CODEX_DISABLED: "1",
  });
  assert.equal(source.HOME, "/operator/home");
});

test("builds retain scrubbed toolchain locations without passing them to isolated services", async () => {
  const source = { PATH: "/fixture/bin", HOME: "/fixture/builder",
    CARGO_HOME: "/fixture/cargo", RUSTUP_HOME: "/fixture/rustup", CARGO_TARGET_DIR: "/fixture/target",
    RUSTUP_TOOLCHAIN: "stable", RUSTC: "/fixture/rustc", RUSTFLAGS: "-C debuginfo=0",
    RUSTDOCFLAGS: "-C debuginfo=0", GH_TOKEN: "must-not-copy", DATABASE_URL: "must-not-copy", NODE_OPTIONS: "must-not-copy" };
  const buildEnv = fixtureChildEnvironment(source);
  assert.deepEqual(buildEnv, Object.fromEntries(Object.entries(source).filter(([key]) =>
    !["GH_TOKEN", "DATABASE_URL", "NODE_OPTIONS"].includes(key))));
  const services = studioProcessEnvironment(buildEnv, "/fixture/empty-service-home");
  assert.equal(services.HOME, "/fixture/empty-service-home");
  for (const key of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR", "RUSTC", "RUSTFLAGS", "RUSTDOCFLAGS"])
    assert.equal(services[key], undefined);
  assert.equal(buildEnv.HOME, source.HOME);
  assert.equal(buildEnv.CARGO_HOME, source.CARGO_HOME);
  assert.equal(buildEnv.RUSTUP_HOME, source.RUSTUP_HOME);

  // Guard the real call sites as well as the environment helpers: Cargo must
  // use run()'s buildEnv default, not the later empty-home service environment.
  const runner = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.match(runner, /const buildEnv = fixtureChildEnvironment\(process\.env\)/);
  assert.match(runner, /const run = \(command, args, options = \{\}\) => runOwnedProcess\(command, args,\s*\{ env: buildEnv, signal, \.\.\.options \}\)/);
  assert.equal((runner.match(/await run\("cargo", \["build", [^\n]+?"--message-format=json"\]\)/g) ?? []).length, 1);
  assert.match(runner, /await run\(process\.execPath, \["scripts\/runtime-cargo\.mjs", "build", [^\n]+?"--bins", "--message-format=json"\]\)/);
});

test("Cargo artifact selection requires exactly one production binary with the requested name", () => {
  const artifact = { reason: "compiler-artifact", profile: { test: false },
    target: { name: "runtime-agent", kind: ["bin"] }, executable: "/fixture/runtime-agent" };
  const line = JSON.stringify(artifact);
  assert.equal(cargoBinaryArtifact(`compiler diagnostic\n${line}\n`, "runtime-agent"), artifact.executable);
  for (const output of ["", `${line}\n${line}`, JSON.stringify({ ...artifact, profile: { test: true } }),
    JSON.stringify({ ...artifact, executable: null }), JSON.stringify({ ...artifact, target: { name: "runtime-agent", kind: ["lib"] } })]) {
    assert.throws(() => cargoBinaryArtifact(output, "runtime-agent"));
  }
  assert.throws(() => cargoBinaryArtifact(line, "runtime-controller"));
});

test("locked Vite CLI resolves through the exported package manifest", async () => {
  const cli = viteCliPath();
  assert.equal(path.basename(cli), "vite.js");
  assert.equal(path.basename(path.dirname(cli)), "bin");
  assert.ok((await stat(cli)).isFile());
});

test("pinned Chromium crosses the empty-HOME boundary only as an executable", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-browser-binary-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "chromium");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const environment = { HOME: "/operator/home", PLAYWRIGHT_BROWSERS_PATH: "/untrusted/cache",
    NODE_OPTIONS: "--require=/untrusted.js", PLAYWRIGHT_EXECUTABLE_PATH: "/untrusted/chromium" };
  const execute = async (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(options.env, { HOME: environment.HOME });
    assert.equal(options.timeout, 5_000);
    assert.equal(options.maxBuffer, 4_096);
    assert.equal(path.isAbsolute(args[2]), true);
    return { stdout: JSON.stringify(executable), stderr: "" };
  };
  assert.equal(await resolvePlaywrightChromiumExecutable({ environment, execute }), await realpath(executable));
  await assert.rejects(
    resolvePlaywrightChromiumExecutable({ environment, execute: async () => ({
      stdout: JSON.stringify(path.join(directory, "missing")), stderr: "",
    }) }),
    /Pinned Playwright Chromium is missing or not executable/,
  );

  const runner = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.ok(runner.indexOf("await resolvePlaywrightChromiumExecutable()") <
    runner.indexOf("studioProcessEnvironment(buildEnv, home)"));
  assert.match(runner, /fixtureControlToken: controlToken, browserExecutablePath/);

  const config = await readFile(
    new URL("../packages/frontend/playwright.shared-studio-ci.config.ts", import.meta.url), "utf8",
  );
  assert.match(config, /launchOptions: \{ executablePath: browserExecutablePath \}/);
  assert.match(config, /fixtureStat\.size > 64 \* 1024/);
  assert.doesNotMatch(config, /userDataDir|storageState|PLAYWRIGHT_BROWSERS_PATH|process\.env\.HOME/);
});

test("fixture page is inert and tests HTTP login, localStorage and HttpOnly invisibility", () => {
  assert.equal(fixtureOrigin, "http://studio-browser-fixture.test");
  const html = fixtureHTML();
  assert.match(html, /fetch\('\/login'/);
  assert.match(html, /fetch\('\/observe'/);
  assert.match(html, /localStorage\.setItem\('fixture_login','studio-proof'\)/);
  assert.match(html, /document\.cookie\.includes\('fixture_http='\)/);
  assert.doesNotMatch(html, /https?:\/\/|SUPABASE|Authorization|access_token|fixtureControlToken/);
});

test("Studio login barrier waits for the browser's complete cookie/storage report before navigation", async () => {
  const spec = await readFile(new URL("../packages/frontend/tests/playwright/smoke/shared-browser-studio-ci.spec.ts", import.meta.url), "utf8");
  const helpers = [spec.match(/^function cookies\([\s\S]*?^}/m)?.[0],
    spec.match(/^async function expectLoginObserved\([\s\S]*?^}/m)?.[0]];
  assert.ok(helpers.every(Boolean));
  const beforeLogin = { cookie: "", storage: null, httpOnlyVisible: false, submissions: 0, observations: 1, modelJobs: 0 };
  const completed = { ...beforeLogin, cookie: "fixture_http=studio-proof; fixture_js=studio-proof",
    storage: "studio-proof", submissions: 1, observations: 2 };
  const incomplete = [
    { ...beforeLogin, submissions: 1 }, // Server received POST; response has not reached Chromium.
    { ...completed, observations: beforeLogin.observations },
    { ...completed, cookie: "fixture_js=studio-proof" }, // HttpOnly response cookie has not arrived.
    { ...completed, cookie: "fixture_http=studio-proof" },
    { ...completed, cookie: `${completed.cookie}; unexpected=extra` },
    { ...completed, storage: null },
    { ...completed, httpOnlyVisible: true },
    { ...completed, modelJobs: 1 },
    { ...completed, submissions: 2 },
  ];
  const states = [...incomplete, completed];
  let reads = 0;
  const polling = { poll(check, options) {
    assert.deepEqual(options, { timeout: 30_000 });
    return { async toEqual(expected) {
      for (let index = 0; index < incomplete.length; index++)
        assert.notDeepEqual(await check(), expected, `incomplete login state ${index} must not complete the barrier`);
      assert.deepEqual(await check(), expected);
    } };
  } };
  const requireFrontend = createRequire(new URL("../packages/frontend/package.json", import.meta.url));
  const { transpileModule } = requireFrontend("typescript");
  const wait = new Function("expect", "state", "PROOF_VALUE",
    `${transpileModule(helpers.join("\n"), {}).outputText}; return expectLoginObserved;`)(
    polling, async () => states[reads++], "studio-proof");
  await wait({}, beforeLogin);
  assert.equal(reads, states.length);
  const submissionAssertion = spec.indexOf(".toBe(beforeLogin.submissions + 1)");
  const barrier = spec.indexOf("await expectLoginObserved(fixture, beforeLogin)");
  const navigation = spec.indexOf('await navigateAndObserve(page, fixture, "signed-in")');
  assert.ok(submissionAssertion >= 0 && submissionAssertion < barrier && barrier < navigation);
});

test("Studio bridges follow owned lease/origin generations when the controller reuses a runtime ID", async () => {
  const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
  let runtime = { id: id(1), leaseId: id(2), originId: id(3) };
  let ownershipChecks = 0;
  let owned = true;
  const attachments = [];
  const ready = createStudioGenerationBridge({
    provider: { async assertOwnedRuntime(runtimeId) {
      ownershipChecks++;
      assert.equal(runtimeId, runtime.id);
      assert.ok(owned, "owned process proof failed");
      return { ...runtime };
    } },
    attach: async current => { attachments.push(current); await new Promise(resolve => setImmediate(resolve)); },
  });
  const initial = { runtimeId: runtime.id, originId: runtime.originId };
  const first = { ...initial, leaseId: runtime.leaseId };
  assert.deepEqual(await Promise.all([ready(initial), ready(initial)]), [first, first]);
  assert.equal(ownershipChecks, 2, "cached generations must still re-prove ownership");
  assert.equal(attachments.length, 1, "concurrent readiness shares one generation bridge");

  runtime = { ...runtime, leaseId: id(4), originId: id(5) };
  const replacement = { runtimeId: runtime.id, originId: runtime.originId };
  assert.deepEqual(await ready(replacement), { ...replacement, leaseId: runtime.leaseId });
  assert.equal(attachments.length, 2, "a reused runtime ID needs a new generation bridge");
  assert.notEqual(attachments[0].leaseId, attachments[1].leaseId);
  assert.notEqual(attachments[0].originId, attachments[1].originId);
  await assert.rejects(ready(initial), /grant must match the current owned origin/);
  owned = false;
  await assert.rejects(ready(replacement), /owned process proof failed/);
  assert.equal(ownershipChecks, 5);
  assert.equal(attachments.length, 2, "stale grants and failed ownership must never attach");
});

test("Studio generation readiness rejects malformed identity and does not cache failed attachment", async () => {
  const runtime = { id: "00000000-0000-4000-8000-000000000001",
    leaseId: "00000000-0000-4000-8000-000000000002", originId: "00000000-0000-4000-8000-000000000003" };
  let attempts = 0;
  const ready = createStudioGenerationBridge({
    provider: { async assertOwnedRuntime() { return { ...runtime }; } },
    attach: async () => { if (++attempts === 1) throw new Error("fixture route setup failed"); },
  });
  const grant = { runtimeId: runtime.id, originId: runtime.originId };
  await assert.rejects(ready({ ...grant, runtimeId: "invalid" }));
  await assert.rejects(ready({ ...grant, originId: "invalid" }));
  await assert.rejects(ready(grant), /fixture route setup failed/);
  assert.deepEqual(await ready(grant), { ...grant, leaseId: runtime.leaseId });
  runtime.leaseId = "invalid";
  await assert.rejects(ready(grant));
  assert.equal(attempts, 2);
});

test("Studio disconnect cleanup attempts every retained CDP connection even if one fails", async () => {
  const closed = [];
  const connections = new Set([1, 2, 3].map(id => ({ close: async () => {
    closed.push(id);
    if (id === 2) throw new Error("fixture disconnect failure");
  } })));
  await assert.rejects(closeStudioConnections(connections), /owned CDP connection cleanup failed/);
  assert.deepEqual(closed, [1, 2, 3]);
  assert.equal(connections.size, 0);
  await closeStudioConnections(connections);
});

test("Studio journey requires fresh origins and owned leases without requiring a new runtime record", async () => {
  const source = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.match(source, /request.url === "\/ready"\) result = await attachBridge\(data\)/);
  assert.ok(source.indexOf("connections.add(browser)") < source.indexOf("const context = browser.contexts()[0]"));
  assert.ok(source.indexOf("if (provider) await provider.close()") < source.indexOf("closeStudioConnections(connections)", source.indexOf("async function lifecycle()")));
  const spec = await readFile(new URL("../packages/frontend/tests/playwright/smoke/shared-browser-studio-ci.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /latestGrant\(\[initial\.originId\]\)/);
  assert.match(spec, /latestGrant\(\[initial\.originId, replacement\.originId\]\)/);
  assert.match(spec, /expect\(generation\.originId\)\.toBe\(grant\.originId\)/);
  assert.match(spec, /expect\(replacementGeneration\.leaseId\)\.not\.toBe\(initialGeneration\.leaseId\)/);
  assert.match(spec, /expect\(clearedGeneration\.leaseId\)\.not\.toBe\(initialGeneration\.leaseId\)/);
  assert.match(spec, /expect\(clearedGeneration\.leaseId\)\.not\.toBe\(replacementGeneration\.leaseId\)/);
  assert.doesNotMatch(spec, /excludedRuntimeIds/);
});

test("failed Studio launches retain only fixed API and provider diagnostics before cleanup", async () => {
  const runner = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.ok(runner.indexOf("provider?.diagnostics()") < runner.indexOf("if (provider) await provider.close()"));
  assert.match(runner, /serviceDiagnostics, providerDiagnostics, databaseDiagnostics/);
  const spec = await readFile(new URL("../packages/frontend/tests/playwright/smoke/shared-browser-studio-ci.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /reported\.size >= 32/);
  assert.match(spec, /status < 100 \|\| status > 599/);
  assert.match(spec, /\[shared-studio-api\]/);
  assert.doesNotMatch(spec, /console\.log\([^\n]*(?:response|request\.url|payload|fixture)/);
});

test("Studio response observers accept the app's localhost normalization only at the fixture port", async () => {
  const spec = await readFile(new URL("../packages/frontend/tests/playwright/smoke/shared-browser-studio-ci.spec.ts", import.meta.url), "utf8");
  // Compile and exercise the actual pure helper without registering/running the
  // environment-gated Playwright suite or creating an authenticated browser.
  const source = spec.match(/^function isControllerURL\([\s\S]*?^}/m)?.[0];
  assert.ok(source);
  const requireFrontend = createRequire(new URL("../packages/frontend/package.json", import.meta.url));
  const { transpileModule } = requireFrontend("typescript");
  const match = new Function(`${transpileModule(source, {}).outputText}; return isControllerURL;`)();
  const fixture = { controllerURL: "http://127.0.0.1:43210" };
  for (const endpoint of ["/access_token", "/runtime/ensure", "/projects/fixture/browser-profile"]) {
    for (const host of ["127.0.0.1", "localhost"]) {
      assert.equal(match(`http://${host}:43210${endpoint}`, fixture, endpoint), true);
    }
    for (const rejected of [`http://localhost:43211${endpoint}`, `https://localhost:43210${endpoint}`,
      `http://remote.invalid:43210${endpoint}`, `http://user@localhost:43210${endpoint}`,
      `http://localhost:43210${endpoint}?token=never-retain`, `http://localhost:43210${endpoint}#fragment`]) {
      assert.equal(match(rejected, fixture, endpoint), false);
    }
  }
  assert.match(spec, /isControllerURL\(response\.url\(\), fixture, "\/access_token"\)/);
  assert.match(spec, /isControllerURL\(response\.url\(\), fixture, `\/projects/);
});

test("Studio and trusted service accounts are provisioned separately and both cleaned up", async () => {
  const source = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.match(source, /serviceUser = JSON\.parse\(await run\(process\.execPath,\s*\["scripts\/mint-test-user\.mjs", "--no-seed-org", "--json"\]/);
  assert.match(source, /SERVICE_RUNTIME_USER_ID: serviceUser\.userId/);
  assert.match(source, /assert\.notEqual\(user\.userId, serviceUser\.userId/);
  assert.match(source, /"--cleanup", user\.userId, "--json"/);
  assert.match(source, /"--cleanup", serviceUser\.userId, "--json"/);
  const rendererFixture = source.slice(source.indexOf("await writeFile(fixture, JSON.stringify("), source.indexOf("const publicConfig ="));
  assert.match(rendererFixture, /userId: user\.userId/);
  assert.doesNotMatch(rendererFixture, /serviceUser|SERVICE_ROLE|SERVICE_RUNTIME/);
});

test("the fixture registers its provider through controller authority without replacing the migration seed", async () => {
  const source = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.match(source, /assert\.deepEqual\(providers, \{ count: 1, seeded: 1 \}/);
  assert.match(source, /providerConfigurationClaimed = true;\s*const registered = await jsonRequest\(`\$\{controllerURL\}\/providers`, \{\s*token: stack\.SERVICE_ROLE_KEY, method: "POST"/);
  assert.match(source, /endpoint: provider\.url, authToken: provider\.token, allowedOrgIds: \[\]/);
  assert.match(source, /if \(providerConfigurationClaimed\) await clean\(\(\) => executeSQL\("delete from runtime_providers where id='instafy-cloud'"\)\)/);
  assert.doesNotMatch(source, /RUNTIME_PROVIDERS:|delete from runtime_providers where id='runtime'/);
});

test("the browser-only allocator does not receive background workspace auto-allocation", async () => {
  const config = await readFile(new URL("../packages/frontend/vite.shared-studio-ci.config.ts", import.meta.url), "utf8");
  assert.match(config, /"import\.meta\.env\.VITE_DISABLE_AUTO_RUNTIME_ENSURE": JSON\.stringify\("1"\)/);
  const spec = await readFile(new URL("../packages/frontend/tests/playwright/smoke/shared-browser-studio-ci.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /getByTestId\("composer-action-menu-open-browser"\)\.click\(\)/);
  assert.match(spec, /getByTestId\("browser-transport-shared"\)\.click\(\)/);
});

async function ownedRoot(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-daemon-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitForFile(filename) {
  for (let retry = 0; retry < 100; retry++) {
    try { return JSON.parse(await readFile(filename, "utf8")); } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("owned daemon fixture did not start");
}

async function assertStopped(pid, { kill = process.kill, read = readFile, platform = process.platform } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let retry = 0; retry < 100; retry++) {
    try { kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
    if (platform === "linux") {
      try {
        const value = await read(`/proc/${pid}/stat`, "utf8");
        if (value.slice(value.lastIndexOf(")") + 1).trimStart().startsWith("Z")) return;
      } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return; throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("owned fixture process survived cleanup");
}

test("Studio stopped-process proof handles procfs exit races without swallowing permission errors", async () => {
  const probe = code => assertStopped(123, { platform: "linux", kill() {},
    read: async () => { throw Object.assign(new Error("fixture read"), { code }); } });
  await probe("ENOENT");
  await probe("ESRCH");
  await assert.rejects(probe("EACCES"), { code: "EACCES" });
});

const daemonFixture = String.raw`
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
if(process.argv[2]==='exit'){child.unref();process.exit(0);}
setInterval(()=>{},1000);
`;

test("daemon close and cancellation terminate the owned service and its descendants", async (t) => {
  for (const cancel of [false, true]) {
    const directory = await ownedRoot(t);
    const filename = path.join(directory, "pids.json");
    const cancellation = new AbortController();
    const daemon = startDaemon(process.execPath, ["-e", daemonFixture, filename], {
      env: studioProcessEnvironment(process.env, directory), cwd: directory, signal: cancellation.signal,
    });
    t.after(() => daemon.close());
    const ids = await waitForFile(filename);
    daemon.assertAlive();
    if (cancel) cancellation.abort();
    await daemon.close();
    await daemon.close(); // Idempotent: no second signal to a recycled group ID.
    for (const pid of ids) await assertStopped(pid);
  }
});

test("guardian retains cleanup ownership after its service exits early", async (t) => {
  const directory = await ownedRoot(t);
  const filename = path.join(directory, "pids.json");
  const daemon = startDaemon(process.execPath, ["-e", daemonFixture, filename, "exit"], {
    env: studioProcessEnvironment(process.env, directory), cwd: directory, signal: new AbortController().signal,
  });
  t.after(() => daemon.close());
  const ids = await waitForFile(filename);
  await assertStopped(ids[0]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => daemon.assertAlive(), /owned fixture service exited/);
  assert.deepEqual(daemon.diagnostics(), { spawnError: false, guardianExited: false, serviceExited: true, serviceExitCode: 0 });
  await daemon.close();
  await assertStopped(ids[1]);
});

test("parent disconnection tears down the guardian's owned service group", async (t) => {
  const directory = await ownedRoot(t);
  const filename = path.join(directory, "pids.json");
  const moduleURL = new URL("./shared-browser-studio-e2e.mjs", import.meta.url).href;
  const parentScript = `import {startDaemon} from ${JSON.stringify(moduleURL)};
    import fs from 'node:fs';
    startDaemon(process.execPath,['-e',process.argv[1],process.argv[2]],{env:process.env,cwd:process.cwd(),signal:new AbortController().signal});
    setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0);},20);
    setTimeout(()=>process.exit(91),5000);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript, daemonFixture, filename], {
    env: studioProcessEnvironment(process.env, directory), cwd: directory, stdio: "ignore",
  });
  t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); });
  const exit = new Promise(resolve => parent.once("exit", resolve));
  const ids = await waitForFile(filename);
  assert.equal(await exit, 0);
  for (const pid of ids) await assertStopped(pid);
});

test("already-aborted daemon startup cannot spawn a service", () => {
  const cancellation = new AbortController(); cancellation.abort();
  assert.throws(() => startDaemon(process.execPath, ["-e", "process.exit(99)"], {
    env: {}, cwd: tmpdir(), signal: cancellation.signal,
  }), { name: "AbortError" });
});

test("runner preserves fresh-DB, scoped-control, cancellation-cleanup and provider serialization contracts", async () => {
  const source = await readFile(new URL("./shared-browser-studio-e2e.mjs", import.meta.url), "utf8");
  assert.match(source, /assert\.deepEqual\(inventory, \{ projects: 0, users: 0 \}/);
  assert.match(source, /await preflightFixtureDisplay\(env, \{ signal \}\)/);
  assert.match(source, /request\.headers\.authorization !== `Bearer \$\{controlToken\}`/);
  assert.match(source, /provider\.currentRuntime\(\)\?\.id, data\.runtimeId/);
  assert.match(source, /await provider\.assertOwnedRuntime\(runtimeId\)/);
  assert.match(source, /displayName: "Disposable managed browser"/);
  assert.match(source, /authToken: provider\.token, allowedOrgIds: \[\]/);
  assert.doesNotMatch(source, /display_name:|auth_token: provider\.token|allowed_org_ids:/);
  assert.match(source, /timeoutMs: 20_000, signal: undefined/);
  assert.match(source, /timeoutMs: 60_000, signal: undefined/);
  assert.match(source, /timeoutMs: 690_000/);
  assert.match(source, /\["scripts\/mint-test-user\.mjs", "--cleanup", user\.userId, "--json"\]/);
  assert.doesNotMatch(source, /--cleanup-all-test-users|\.env\.supabase|process\.env\.SUPABASE/);
});
