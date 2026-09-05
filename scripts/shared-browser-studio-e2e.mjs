#!/usr/bin/env node
// Real signed-in Studio + controller + native runtime. The only allocator is
// an owned local fixture; no model/provider credentials or .env files are read.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createDecipheriv, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFixtureEntrypoint, fixtureChildEnvironment, installCancellationSignalHandlers,
  preflightFixtureDisplay, runOwnedProcess } from "./browser-profile-e2e.mjs";
import { parseShellEnv } from "./lib/localSupabaseEnv.mjs";
import { assertTargetAllowed, decodeJwtClaims } from "./mint-test-user.mjs";
import { startStudioProvider } from "./lib/sharedStudioProvider.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const frontend = path.join(root, "packages/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const fixedRoot = "/tmp/instafy";
const receiptPath = path.join(frontend, "test-results/browser-ci/shared-studio/result.json");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const fixtureOrigin = "http://studio-browser-fixture.test";

export function validateStudioStack(status, platform = process.platform) {
  assert.equal(platform, "linux", "Shared Studio fixture requires disposable Linux");
  for (const [key, protocol] of [["API_URL", "http:"], ["DB_URL", "postgresql:"]]) {
    const url = new URL(status[key]);
    assert.equal(url.protocol, protocol);
    assert.equal(url.hostname, "127.0.0.1", "explicit literal-loopback local stack required");
    assert.ok(url.port, "explicit local stack port required");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    if (key === "API_URL") {
      assert.equal(url.username, ""); assert.equal(url.password, ""); assert.equal(url.pathname, "/");
    }
  }
  assertTargetAllowed({ target: "local", supabaseUrl: status.API_URL,
    serviceRoleKey: status.SERVICE_ROLE_KEY, env: {} });
  for (const [key, role] of [["ANON_KEY", "anon"], ["SERVICE_ROLE_KEY", "service_role"]]) {
    const claims = decodeJwtClaims(status[key]);
    assert.ok(claims?.role === role && claims?.iss === "supabase-demo" && !claims?.ref,
      "only disposable local stack JWT keys are permitted");
  }
  assert.ok(status.JWT_SECRET, "local stack must report its disposable JWT secret");
}

export function studioProcessEnvironment(env, home) {
  const build = fixtureChildEnvironment(env);
  for (const key of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR", "RUSTFLAGS", "RUSTDOCFLAGS", "RUSTC"])
    delete build[key];
  return { ...build, HOME: home, CODEX_HOME: path.join(home, ".codex"),
    INSTAFY_ENV_DIR: path.join(home, "empty-env"), CODEX_DISABLED: "1" };
}

export function cargoBinaryArtifact(output, target) {
  const artifacts = output.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter(value => value.reason === "compiler-artifact" && !value.profile?.test &&
    value.target?.name === target && value.target?.kind?.includes("bin") && value.executable);
  assert.equal(artifacts.length, 1, "exactly one built fixture binary required");
  return artifacts[0].executable;
}

export function viteCliPath() {
  // Vite exports package.json, but not the bin/vite.js package subpath.
  return path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function freePort() {
  const server = createTcpServer();
  await listen(server); const port = server.address().port;
  await closeServer(server); return port;
}
async function poll(check, signal, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("fixture condition did not become ready before its deadline");
}
async function jsonRequest(url, { token, body, method = "GET", timeout = 20_000 } = {}) {
  const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(timeout),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `fixture HTTP request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

const daemonGuardian = String.raw`
const { spawn } = require('node:child_process');
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  // This live process is its own group leader: its PID cannot be reused while
  // it sends these signals. Keep it alive until the final group-wide kill.
  process.kill(-process.pid, 'SIGTERM');
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 300);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
process.on('message', message => { if (message?.stop === true) stop(); });
const [command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { stdio: 'ignore' });
const report = code => {
  if (process.connected) process.send({ serviceExited: true,
    serviceExitCode: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null }, () => {});
};
child.once('error', () => report(null));
child.once('exit', report);
setInterval(() => {}, 1000);
`;

export function startDaemon(command, args, { env, cwd, signal }) {
  // Logs can include signed origin grants. They are discarded, never retained
  // or echoed. Only a fixed liveness boolean crosses the private IPC channel.
  // The guardian owns group cleanup even if the service exits before close(),
  // and on parent disconnection; the parent never signals a recycled group ID.
  signal?.throwIfAborted();
  const child = spawn(process.execPath, ["-e", daemonGuardian, command, ...args],
    { env, cwd, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let exited = false;
  let serviceExited = false;
  let serviceExitCode = null;
  let spawnError = false;
  let closing;
  child.once("error", () => { spawnError = true; exited = true; });
  child.on("message", message => {
    if (message?.serviceExited === true) {
      serviceExited = true;
      if (Number.isInteger(message.serviceExitCode) && message.serviceExitCode >= 0 && message.serviceExitCode <= 255)
        serviceExitCode = message.serviceExitCode;
    }
  });
  const exit = new Promise(resolve => child.once("exit", (_code, exitSignal) => {
    exited = true; resolve(exitSignal);
  }));
  const close = () => {
    signal?.removeEventListener("abort", cancel);
    closing ??= (async () => {
      assert.ok(!exited, "owned fixture guardian exited before cleanup");
      child.send({ stop: true }, () => {});
      let timer;
      try {
        const exitSignal = await Promise.race([exit, new Promise(resolve => {
          timer = setTimeout(() => resolve("cleanup-timeout"), 5_000);
        })]);
        assert.equal(exitSignal, "SIGKILL", "owned fixture group cleanup was not confirmed");
      } finally {
        clearTimeout(timer);
        if (!exited) child.kill("SIGKILL"); // Exact still-owned handle only.
      }
    })();
    return closing;
  };
  const cancel = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return {
    assertAlive() { assert.ok(!spawnError && !exited && !serviceExited, "owned fixture service exited before readiness"); },
    diagnostics() { return { spawnError, guardianExited: exited, serviceExited, serviceExitCode }; },
    close,
  };
}

export function fixtureHTML() {
  return `<!doctype html><html><head><title>Disposable Shared Browser</title><style>
html,body{margin:0;background:#ecfdf5;color:#123;font:20px sans-serif;height:100%}
input{position:absolute;left:20px;top:20px;width:300px;height:50px;box-sizing:border-box}
button{position:absolute;left:0;top:110px;width:200px;height:60px}p{position:absolute;top:200px;left:20px}
</style></head><body><form><input aria-label="Fixture login" autofocus autocomplete="off"><button>Save test login</button></form><p>Disposable site — no real account</p><script>
const report=()=>fetch('/observe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storage:localStorage.getItem('fixture_login'),httpOnlyVisible:document.cookie.includes('fixture_http=')})});
document.querySelector('form').onsubmit=async event=>{event.preventDefault();if(document.querySelector('input').value!=='studio-proof')return;document.cookie='fixture_js=studio-proof; Path=/; SameSite=Lax; Max-Age=3600';localStorage.setItem('fixture_login','studio-proof');await fetch('/login',{method:'POST'});await report();document.querySelector('p').textContent='Test login saved';};
report();</script></body></html>`;
}

async function lifecycle() {
  assert.equal(process.argv.length, 2, "this required lane does not accept test filters or overrides");
  assert.equal(process.platform, "linux", "Shared Studio fixture requires disposable Linux");
  assert.ok(process.env.DISPLAY, "run this fixture through xvfb-run");
  const buildEnv = fixtureChildEnvironment(process.env);
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  const removeSignals = installCancellationSignalHandlers(cancellation);
  const temporary = await mkdtemp(path.join(tmpdir(), "instafy-shared-studio-"));
  const run = (command, args, options = {}) => runOwnedProcess(command, args,
    { env: buildEnv, signal, ...options });
  let claimed = false, passed = false, stage = "preflight", user, serviceUser, projectId, controller, vite, provider, site, control;
  let stack, providerConfigurationClaimed = false;
  const started = Date.now();
  const connections = new Map();
  const cleanupErrors = [];
  const clean = async action => { try { await action(); } catch { cleanupErrors.push("owned-resource-cleanup-failed"); } };
  const sql = async query => JSON.parse((await run("psql", [stack.DB_URL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
    `select coalesce(json_agg(fixture_row), '[]'::json) from (${query}) fixture_row`], { timeoutMs: 20_000 })).trim());
  // Cleanup gets its own bounded command budget even after the run is aborted.
  const executeSQL = query => run("psql", [stack.DB_URL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query], { timeoutMs: 20_000, signal: undefined });
  try {
    await mkdir(fixedRoot); claimed = true;
    await mkdir(path.join(fixedRoot, "playwright"));
    await writeFile(path.join(fixedRoot, "studio-e2e-owner.json"), JSON.stringify({ runId: randomUUID(), root: temporary }), { flag: "wx", mode: 0o600 });
    stage = "local-stack-status";
    stack = parseShellEnv(await run("pnpm", ["exec", "supabase", "--workdir", "supabase", "status", "--output", "env"], { timeoutMs: 30_000 }));
    stage = "local-stack-validation";
    validateStudioStack(stack);
    stage = "fresh-database-check";
    const [inventory] = await sql("select (select count(*) from projects)::integer as projects, (select count(*) from auth.users)::integer as users");
    assert.deepEqual(inventory, { projects: 0, users: 0 }, "refusing an occupied local database; use a fresh disposable stack");
    const [providers] = await sql("select count(*)::integer as count, count(*) filter (where id='runtime' and kind='docker' and endpoint is null and auth_token is null)::integer as seeded from runtime_providers");
    assert.deepEqual(providers, { count: 1, seeded: 1 }, "only the unchanged migration-seeded provider is permitted");
    stage = "sqlite-preflight";
    await run("sqlite3", [":memory:", "select 1"], { timeoutMs: 5_000 });
    const home = path.join(temporary, "home");
    const bin = path.join(temporary, "bin");
    await mkdir(home); await mkdir(bin);
    const env = studioProcessEnvironment(buildEnv, home);
    const entrypoint = await copyFixtureEntrypoint(bin);
    stage = "build-egress-helper";
    await run("go", ["build", "-o", path.join(bin, "browser-egress-proxy"), "."], { cwd: path.join(root, "packages/browser-egress-proxy") });
    stage = "build-runtime";
    const agentBinary = cargoBinaryArtifact(await run("cargo", ["build", "--locked", "--manifest-path", "packages/runtime-agent/Cargo.toml", "--bin", "runtime-agent", "--message-format=json"]), "runtime-agent");
    stage = "build-controller";
    const controllerBinary = cargoBinaryArtifact(await run("cargo", ["build", "--locked", "--manifest-path", "packages/runtime-controller/Cargo.toml", "--bin", "runtime-controller", "--message-format=json"]), "runtime-controller");
    stage = "display-preflight";
    assert.equal(await preflightFixtureDisplay(env, { signal }), "ready", "Shared Studio X-display preflight failed");
    const controllerURL = `http://127.0.0.1:${await freePort()}`;
    const baseURL = `http://127.0.0.1:${await freePort()}`;
    provider = await startStudioProvider({ root: temporary, bin, agentBinary, entrypoint, env,
      controllerURL, signal });
    stage = "mint-service-user";
    serviceUser = JSON.parse(await run(process.execPath,
      ["scripts/mint-test-user.mjs", "--no-seed-org", "--json"], { timeoutMs: 90_000 }));
    assert.match(serviceUser.userId, uuid);
    const encryptionKey = randomBytes(32);
    const keys = generateKeyPairSync("ed25519");
    const controllerEnv = { ...env, PORT: new URL(controllerURL).port, DATABASE_URL: stack.DB_URL,
      SUPABASE_PROJECT_URL: stack.API_URL, SUPABASE_JWT_SECRET: stack.JWT_SECRET,
      SUPABASE_SERVICE_ROLE_KEY: stack.SERVICE_ROLE_KEY,
      // Provision the controller's trusted service identity explicitly. Never
      // reuse the ordinary Studio user here: that would confer service authority
      // on the renderer. Automatic service-account bootstrap is outside this lane.
      SERVICE_RUNTIME_USER_ID: serviceUser.userId,
      CONTROLLER_INTERNAL_TOKEN: randomBytes(32).toString("hex"), USER_TOKEN_SECRET: randomBytes(32).toString("hex"),
      AGENT_LOGIN_KEY: randomBytes(32).toString("hex"), DEV_MODE: "true", STRICT_MODE: "true",
      MANAGED_AI_ENABLED: "false", MANAGED_AI_STARTUP_CHECK: "false", BROWSER_PROFILE_SNAPSHOT_SECS: "5",
      CREDENTIAL_ENCRYPTION_KEY: encryptionKey.toString("base64"),
      RUNTIME_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      RUNTIME_SIGNING_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }),
      RUNTIME_SIGNING_KEY_ID: "shared-studio-fixture", WORKSPACE_ROOT: path.join(temporary, "workspaces"),
      CONTROLLER_EXTERNAL_URL: controllerURL, RUST_LOG: "error" };
    const bootController = async () => {
      controller = startDaemon(controllerBinary, [], { cwd: temporary, env: controllerEnv, signal });
      await poll(async () => {
        controller.assertAlive();
        try { return (await fetch(`${controllerURL}/healthz`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, signal, 30_000);
    };
    stage = "controller-start";
    await bootController();
    stage = "register-fixture-provider";
    // The migrated provider registry is authoritative, so RUNTIME_PROVIDERS
    // cannot override its seeded row. Register via the real administrative API;
    // the generated token never enters SQL command arguments or the renderer.
    // Claim cleanup before sending: the server may commit even if its reply fails.
    providerConfigurationClaimed = true;
    const registered = await jsonRequest(`${controllerURL}/providers`, {
      token: stack.SERVICE_ROLE_KEY, method: "POST", body: {
        id: "instafy-cloud", displayName: "Disposable managed browser", kind: "external_http",
        endpoint: provider.url, authToken: provider.token, allowedOrgIds: [],
      },
    });
    assert.equal(registered.id, "instafy-cloud");
    assert.equal(registered.kind, "external_http");
    stage = "mint-user";
    user = JSON.parse(await run(process.execPath, ["scripts/mint-test-user.mjs", "--json"], { timeoutMs: 90_000 }));
    assert.match(user.userId, uuid); assert.match(user.org?.id, uuid);
    assert.notEqual(user.userId, serviceUser.userId, "Studio and service identities must remain distinct");
    const userToken = JSON.parse(user.localStorageValue).access_token;
    stage = "create-project";
    ({ projectId } = await jsonRequest(`${controllerURL}/orgs/${user.org.id}/projects`,
      { token: userToken, method: "POST", body: { projectName: "Disposable Shared Browser journey", projectType: "customer" } }));
    assert.match(projectId, uuid);
    stage = "controller-reconfigure";
    await controller.close();
    controllerEnv.BROWSER_PROFILE_PERSIST_PROJECT_IDS = projectId;
    provider.setProject(projectId);
    stage = "controller-restart";
    await bootController();
    stage = "fixture-control-server";
    const observed = { cookie: "", storage: null, httpOnlyVisible: false, submissions: 0, observations: 0 };
    site = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.url === "/login" && request.method === "POST") {
        observed.submissions += 1;
        response.setHeader("Set-Cookie", "fixture_http=studio-proof; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600");
        response.end("ok");
      } else if (request.url === "/observe" && request.method === "POST") {
        try {
          let body = "";
          for await (const chunk of request) { body += chunk; assert.ok(body.length < 4096); }
          const data = JSON.parse(body);
          observed.cookie = request.headers.cookie ?? "";
          observed.storage = data.storage;
          observed.httpOnlyVisible = data.httpOnlyVisible;
          observed.observations += 1;
          response.end("ok");
        } catch { response.writeHead(400).end(); }
      } else if (request.url === "/" && request.method === "GET") {
        response.setHeader("Content-Type", "text/html"); response.end(fixtureHTML());
      } else response.writeHead(404).end();
    });
    const siteURL = await listen(site);
    const attachBridge = async runtimeId => {
      const runtime = await provider.assertOwnedRuntime(runtimeId);
      if (connections.has(runtimeId)) return;
      const { chromium } = require("@playwright/test");
      const browser = await poll(async () => {
        try { return await chromium.connectOverCDP(`http://127.0.0.1:${runtime.cdpPort}`, { timeout: 1_000 }); } catch { return false; }
      }, signal);
      const context = browser.contexts()[0];
      assert.ok(context, "real runtime persistent context required");
      await context.route(`${fixtureOrigin}/**`, async route => {
        const original = new URL(route.request().url());
        const headers = await route.request().allHeaders(); headers.cookie ??= "";
        // The backend leg is Node HTTP, with exactly the browser's Cookie
        // header and no APIRequestContext cookie jar. Chromium's public-only
        // egress proxy remains intact; only this fixed fixture origin is bridged.
        const body = route.request().postDataBuffer();
        const reply = await fetch(`${siteURL}${original.pathname}${original.search}`, {
          method: route.request().method(), headers, ...(body ? { body } : {}),
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        await route.fulfill({ status: reply.status, headers: Object.fromEntries(reply.headers),
          body: Buffer.from(await reply.arrayBuffer()) });
      });
      connections.set(runtimeId, browser);
    };
    const snapshotReady = async runtimeId => {
      assert.equal(provider.currentRuntime()?.id, runtimeId);
      const rows = await sql(`select version, nonce_b64, ciphertext_b64 from project_browser_profiles where project_id='${projectId}'`);
      if (rows.length !== 1) return false;
      const encrypted = Buffer.from(rows[0].ciphertext_b64, "base64");
      assert.ok(encrypted.length <= 32 * 1024 * 1024);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(rows[0].nonce_b64, "base64"));
      decipher.setAuthTag(encrypted.subarray(-16));
      const archive = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      const { unzipSync } = require("fflate");
      const files = unzipSync(archive, { filter: file => {
        assert.ok(file.originalSize <= 64 * 1024 * 1024);
        return ["Default/Cookies", "Default/Network/Cookies"].includes(file.name) || file.name.startsWith("Default/Local Storage/leveldb/");
      } });
      const cookies = files["Default/Network/Cookies"] ?? files["Default/Cookies"];
      if (!cookies || !Object.entries(files).some(([name, bytes]) => name.includes("Local Storage/") && Buffer.from(bytes).includes(Buffer.from("studio-proof")))) return false;
      const sqlitePath = path.join(temporary, "snapshot-cookies.sqlite");
      await writeFile(sqlitePath, cookies, { mode: 0o600 });
      try {
        const result = await run("sqlite3", ["-readonly", sqlitePath,
          "select count(*) from cookies where host_key='studio-browser-fixture.test' and ((name='fixture_http' and is_httponly=1) or (name='fixture_js' and is_httponly=0));"], { timeoutMs: 5_000 });
        return result.trim() === "2" ? { runtimeId, version: Number(rows[0].version) } : false;
      } finally { await rm(sqlitePath, { force: true }); }
    };
    const controlToken = randomBytes(32).toString("hex");
    control = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
      if (request.headers.authorization !== `Bearer ${controlToken}`) { response.writeHead(403).end("{}"); return; }
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; assert.ok(body.length < 4096); }
        const data = body ? JSON.parse(body) : {};
        let result = {};
        if (request.url === "/state" && request.method === "GET") {
          const [jobs] = await sql(`select count(*)::integer as count from agent_jobs where project_id='${projectId}'`);
          result = { ...observed, modelJobs: jobs.count };
        } else if (request.url === "/checkpoint" && request.method === "POST") {
          assert.equal(observed.submissions, 0);
        } else if (request.method === "POST" && ["/ready", "/wait-snapshot", "/stop-runtime"].includes(request.url)) {
          assert.match(data.runtimeId, uuid); assert.equal(provider.currentRuntime()?.id, data.runtimeId);
          if (request.url === "/ready") await attachBridge(data.runtimeId);
          else if (request.url === "/wait-snapshot") result = await poll(() => snapshotReady(data.runtimeId), signal, 90_000);
          else {
            const stopped = await jsonRequest(`${controllerURL}/runtime/stop`, { token: userToken, method: "POST", timeout: 45_000,
              body: { runtime_id: data.runtimeId, expected_project_id: projectId, expected_provider: "instafy-cloud", require_provider_release: true, reason: "disposable-studio-restart" } });
            assert.equal(stopped.ok, true); assert.equal(stopped.provider_release_succeeded, true);
            result = { retiredRuntimeId: data.runtimeId };
          }
        } else { response.writeHead(404).end("{}"); return; }
        response.end(JSON.stringify(result));
      } catch { response.writeHead(500).end('{"error":"fixture-operation-failed"}'); }
    });
    const fixtureControlURL = await listen(control);
    const fixture = path.join(temporary, "studio-fixture.json");
    await writeFile(fixture, JSON.stringify({ baseURL, controllerURL, projectId, userId: user.userId,
      storageKey: user.storageKey, localStorageValue: user.localStorageValue, fixturePageURL: `${fixtureOrigin}/`,
      fixtureControlURL, fixtureControlToken: controlToken }), { mode: 0o600, flag: "wx" });
    const publicConfig = JSON.stringify({ supabaseURL: stack.API_URL, anonKey: stack.ANON_KEY, controllerURL });
    stage = "studio-server";
    vite = startDaemon(process.execPath, [viteCliPath(), "--config", "vite.shared-studio-ci.config.ts", "--port", new URL(baseURL).port],
      { cwd: frontend, env: { ...env, INSTAFY_STUDIO_E2E_PUBLIC_CONFIG: publicConfig }, signal });
    await poll(async () => { vite.assertAlive(); try { return (await fetch(baseURL, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, signal, 30_000);
    stage = "signed-in-browser-journey";
    await run(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", "playwright.shared-studio-ci.config.ts"],
      { cwd: frontend, env: { ...env, INSTAFY_STUDIO_E2E_FIXTURE: fixture }, timeoutMs: 690_000, onOutput: data => process.stdout.write(data) });
    const result = JSON.parse(await readFile(path.join(frontend, "test-results/browser-ci/shared-studio/required-browser-result.json"), "utf8"));
    assert.equal(result.status, "passed"); assert.equal(result.passed, 1); assert.equal(result.skipped, 0);
    passed = true;
  } finally {
    const serviceDiagnostics = { controller: controller?.diagnostics() ?? null, vite: vite?.diagnostics() ?? null };
    stage = passed ? "cleanup" : stage;
    await clean(async () => { if (vite) await vite.close(); });
    await clean(async () => { if (control) await closeServer(control); });
    await clean(async () => { if (provider) await provider.close(); });
    await clean(async () => { if (site) await closeServer(site); });
    await clean(async () => { if (controller) await controller.close(); });
    if (projectId && uuid.test(projectId)) await clean(() => executeSQL(`delete from projects where id='${projectId}'`));
    if (user?.userId && uuid.test(user.userId)) await clean(() => run(process.execPath,
      ["scripts/mint-test-user.mjs", "--cleanup", user.userId, "--json"], { timeoutMs: 60_000, signal: undefined }));
    if (serviceUser?.userId && uuid.test(serviceUser.userId)) await clean(() => run(process.execPath,
      ["scripts/mint-test-user.mjs", "--cleanup", serviceUser.userId, "--json"], { timeoutMs: 60_000, signal: undefined }));
    if (providerConfigurationClaimed) await clean(() => executeSQL("delete from runtime_providers where id='instafy-cloud'"));
    if (claimed) await clean(() => rm(fixedRoot, { recursive: true }));
    await clean(() => rm(temporary, { recursive: true }));
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, lane: "shared-studio", status: passed && !cleanupErrors.length ? "passed" : "failed",
      stage, durationMs: Date.now() - started, cleanupErrors, serviceDiagnostics,
      proof: passed ? ["real-local-auth", "authenticated-project-creation", "studio-shared-launch", "real-origin-pixels-and-input", "periodic-encrypted-snapshot", "provider-acknowledged-stop", "replacement-cookie-restore", "ui-clear-no-resurrection"] : [],
      excludes: ["cloud-provider-allocation", "network-egress-transport", "model-turns", "cross-user-collaboration", "automatic-service-account-bootstrap", "OS-isolation"] }, null, 2) + "\n");
    removeSignals();
    assert.equal(cleanupErrors.length, 0, "fixture cleanup failed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try { await lifecycle(); process.exit(0); }
  catch { console.error("Shared Studio fixture failed; see the fixed-stage credential-free result receipt."); process.exit(1); }
}
