import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cargoBinaryArtifact, fixtureHTML, fixtureOrigin, startDaemon,
  studioProcessEnvironment, validateStudioStack, viteCliPath } from "./shared-browser-studio-e2e.mjs";
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
    CONTROLLER_URL: "https://remote.invalid", HTTP_PROXY: "http://remote.invalid", VITE_SUPABASE_URL: "https://remote.invalid" };
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
  assert.equal((runner.match(/await run\("cargo", \["build", [^\n]+?"--message-format=json"\]\)/g) ?? []).length, 2);
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

test("fixture page is inert and tests HTTP login, localStorage and HttpOnly invisibility", () => {
  assert.equal(fixtureOrigin, "http://studio-browser-fixture.test");
  const html = fixtureHTML();
  assert.match(html, /fetch\('\/login'/);
  assert.match(html, /fetch\('\/observe'/);
  assert.match(html, /localStorage\.setItem\('fixture_login','studio-proof'\)/);
  assert.match(html, /document\.cookie\.includes\('fixture_http='\)/);
  assert.doesNotMatch(html, /https?:\/\/|SUPABASE|Authorization|access_token|fixtureControlToken/);
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
