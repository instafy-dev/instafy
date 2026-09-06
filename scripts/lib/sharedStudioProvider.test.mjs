import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import test from "node:test";

import {
  clearOwnedBrowserBookkeeping,
  fixedBrowserDirectoryIsOwned,
  runtimeDiagnosticCollector,
  startStudioProvider,
} from "./sharedStudioProvider.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const originId = "44444444-4444-4444-8444-444444444444";

test("runtime startup diagnostics are bounded fixed categories, including split messages", () => {
  const categories = [];
  const collect = runtimeDiagnosticCollector(category => categories.push(category));
  collect(Buffer.from("Bearer never-retain-this-token https://private.invalid runtime-agent boot"));
  collect(Buffer.from("strap starting\n failed to register runtime secret=never-retain-this-token"));
  collect(Buffer.from("failed to register runtime\n origin HTTP server listening"));
  assert.deepEqual(categories, ["bootstrap-started", "runtime-registration-failed", "origin-listening"]);
  collect(Buffer.alloc(8 * 1024 * 1024));
  collect(Buffer.from("runtime agent terminated with error"));
  assert.deepEqual(categories, ["bootstrap-started", "runtime-registration-failed", "origin-listening", "diagnostic-limit-reached"]);
  assert.doesNotMatch(JSON.stringify(categories), /Bearer|never-retain|private\.invalid/);
});

test("Chromium readiness warnings are classified even when its launcher exits successfully", () => {
  const categories = [];
  const collect = runtimeDiagnosticCollector(category => categories.push(category));
  collect(Buffer.from("[instafy] Headed Chromium ready (CDP) on private-address\n"));
  collect(Buffer.from("[instafy] Headed Chromium did not become ready; Check /private/profile\n"));
  collect(Buffer.from("no Chromium executable found token=never-retain\n"));
  assert.deepEqual(categories, ["chromium-cdp-ready", "chromium-cdp-not-ready", "chromium-executable-missing"]);
  assert.doesNotMatch(JSON.stringify(categories), /private|never-retain/);
});

async function fixture(t, { rootSuffix = "", ...options } = {}) {
  // macOS's ambient TMPDIR is much longer than disposable Linux's /tmp.
  const temporaryRoot = await mkdtemp("/tmp/iss-provider-");
  const root = path.join(temporaryRoot, rootSuffix);
  await mkdir(root, { recursive: true });
  const bin = path.join(root, "bin");
  const entrypoint = path.join(bin, "runtime-entrypoint");
  const agent = path.join(root, "fake-agent.mjs");
  await mkdir(bin);
  await writeFile(entrypoint, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(
    agent,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
console.error("runtime-agent bootstrap starting token=never-retain-this-token");
console.log("runtime agent configuration loaded https://private.invalid");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
let listening = 0;
for (const port of [9223, 9226]) createServer().listen(port, "127.0.0.1", () => {
  listening += 1;
  if (listening === 2) writeFileSync(path.join(process.env.WORKSPACE_DIR, "observed-env.json"), JSON.stringify({ env: process.env, descendantPid: descendant.pid }));
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  await chmod(agent, 0o700);
  const callbacks = [];
  const provider = await startStudioProvider({
    root,
    bin,
    agentBinary: agent,
    entrypoint,
    env: {
      PATH: process.env.PATH,
      DISPLAY: ":77",
      LANG: "C.UTF-8",
      OPENAI_API_KEY: "must-not-copy",
      DATABASE_URL: "must-not-copy",
      GH_TOKEN: "must-not-copy",
      NODE_OPTIONS: "--require=must-not-copy",
    },
    controllerURL: "http://127.0.0.1:8788",
    onRuntime(runtime) {
      callbacks.push(runtime);
    },
    ...options,
  });
  t.after(async () => {
    await provider.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  return { root, provider, callbacks };
}

function ensureBody(overrides = {}) {
  return {
    project_id: projectId,
    runtime_id: runtimeId,
    lease_id: leaseId,
    provider: "instafy-cloud",
    runtime_token: "inert-controller-minted-runtime-token-with-enough-bytes",
    origin_instance_id: originId,
    origin_mode: "hosted",
    origin_protocols: ["http"],
    metadata: {
      runtimeFlavor: "webdev",
      source: "browser-session",
      runtimeImagePreset: "default",
      sizeId: "starter",
      _instafyManagedRuntimeLaunch: {
        version: 1,
        flavor: "webdev",
        generation: leaseId,
      },
      env: {
        RUNTIME_CPU_LIMIT: "2",
        RUNTIME_MEMORY_LIMIT: "4g",
        INSTAFY_ENABLE_BROWSER_SESSION: "1",
        INSTAFY_BROWSER_VIEWPORT_ONLY: "1",
        INSTAFY_BROWSER_CDP_SCREENCAST: "1",
        INSTAFY_BROWSER_DISPLAY: ":1",
        INSTAFY_VNC_PORT: "5900",
        INSTAFY_VNC_GEOMETRY: "1280x720",
        INSTAFY_BROWSER_PROFILE_PERSIST: "1",
        INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS: "5",
      },
    },
    ...overrides,
  };
}

async function providerFetch(provider, route, body, token = provider.token) {
  return fetch(`${provider.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForFile(file) {
  // A cold fake Node worker can take just over a second to start on macOS.
  // Bound infrastructure startup at five seconds without retrying any test.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  assert.fail("fake runtime did not report its environment");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("attested ensure launches one actual owned process with a scrubbed production-shaped environment", async t => {
  const { root, provider, callbacks } = await fixture(t);
  provider.setProject(projectId);
  const unauthorized = await providerFetch(provider, "/runtime/ensure", ensureBody(), "wrong-token");
  assert.equal(unauthorized.status, 401);

  const response = await providerFetch(provider, "/runtime/ensure", ensureBody());
  assert.equal(response.status, 200);
  const runtime = provider.currentRuntime();
  assert.equal(runtime.id, runtimeId);
  assert.equal(runtime.leaseId, leaseId);
  assert.equal(runtime.projectId, projectId);
  assert.equal(runtime.originId, originId);
  assert.equal(runtime.cdpPort, 9223);
  assert.equal(
    runtime.profileDir,
    path.join(await realpath(root), "runtimes", runtimeId, leaseId, "profile"),
  );
  assert.equal(runtime.status, "running");
  assert.ok(processIsAlive(runtime.pid));
  await assert.rejects(
    provider.assertOwnedRuntime("55555555-5555-4555-8555-555555555555"),
    /does not own the requested live runtime generation/,
  );
  await assert.rejects(
    provider.assertOwnedRuntime(runtimeId),
    process.platform === "linux"
      ? /fixed browser directory|runtime-agent no longer matches|Chromium PID file/
      : /requires disposable Linux/,
  );

  const observation = JSON.parse(
    await waitForFile(path.join(root, "runtimes", runtimeId, leaseId, "workspace", "observed-env.json")),
  );
  const observed = observation.env;
  assert.equal(path.dirname(observed.TMPDIR), await realpath(root));
  assert.match(path.basename(observed.TMPDIR), /^t-[a-zA-Z0-9]{6}$/);
  assert.ok(Buffer.byteLength(observed.TMPDIR) <= 50);
  assert.equal((await lstat(observed.TMPDIR)).mode & 0o777, 0o700);
  // Exercise a real Unix socket with Chromium's generated suffix, not only
  // a string-length assertion. The old UUID-nested TMPDIR cannot bind this.
  const socketDirectory = await mkdtemp(path.join(observed.TMPDIR, ".org.chromium.Chromium."));
  const socket = createTcpServer();
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(path.join(socketDirectory, "SingletonSocket"), resolve);
    });
  } finally {
    if (socket.listening) await new Promise(resolve => socket.close(resolve));
  }
  const diagnostics = provider.diagnostics();
  assert.equal(diagnostics.ensureRequests, 1);
  assert.equal(diagnostics.ensureFailures, 1); // Rejected authorization above.
  assert.equal(diagnostics.validatedEnsures, 1);
  assert.equal(diagnostics.launches, 1);
  assert.equal(diagnostics.validationStage, "validated");
  assert.equal(diagnostics.launchStage, "launched");
  assert.equal(diagnostics.lastEnsureStatus, 200);
  assert.deepEqual(diagnostics.categories, ["bootstrap-started", "configuration-loaded"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /never-retain|private\.invalid|Bearer|token=/);
  assert.ok(processIsAlive(observation.descendantPid));
  assert.equal(observed.SPACE_ID, projectId);
  assert.equal(observed.RUNTIME_ID, runtimeId);
  assert.equal(observed.RUNTIME_LEASE_ID, leaseId);
  assert.equal(observed.RUNTIME_PROVIDER, "instafy-cloud");
  assert.equal(observed.ORIGIN_ID, originId);
  assert.equal(observed.ORIGIN_ENDPOINT, runtime.originUrl);
  assert.equal(observed.CONTROLLER_BASE_URL, "http://127.0.0.1:8788");
  assert.equal(
    observed.INSTAFY_RUNTIME_ENTRYPOINT,
    await realpath(path.join(root, "bin", "runtime-entrypoint")),
  );
  assert.equal(observed.INSTAFY_BROWSER_PROFILE_PERSIST, "1");
  assert.equal(observed.INSTAFY_BROWSER_CDP_SCREENCAST, "1");
  assert.equal(observed.DISPLAY, ":77");
  assert.equal(observed.INSTAFY_BROWSER_DISPLAY, ":77");
  assert.equal(observed.INSTAFY_PLAYWRIGHT_PROFILE_DIR, runtime.profileDir);
  assert.equal(
    observed.NODE_PATH,
    observed.INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT,
  );
  assert.equal(
    path.dirname(observed.INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH),
    observed.INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT,
  );
  assert.equal(path.basename(observed.INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH), "playwright");
  assert.equal(observed.CODEX_DISABLED, "1");
  assert.equal(observed.INSTAFY_RUNTIME_PARENT_DISPOSITION, "1");
  for (const secret of ["OPENAI_API_KEY", "DATABASE_URL", "GH_TOKEN", "NODE_OPTIONS"] ) {
    assert.equal(observed[secret], undefined);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].pid, runtime.pid);
  assert.equal(callbacks[0].runtimeToken, undefined);

  const idempotent = await providerFetch(provider, "/runtime/ensure", ensureBody());
  assert.equal(idempotent.status, 200);
  assert.equal(provider.currentRuntime().pid, runtime.pid);
  assert.equal(callbacks.length, 1);

  const staleRelease = await providerFetch(provider, "/runtime/release", {
    project_id: projectId,
    runtime_id: runtimeId,
    lease_id: "55555555-5555-4555-8555-555555555555",
  });
  assert.equal(staleRelease.status, 204);
  assert.ok(processIsAlive(runtime.pid));

  const released = await providerFetch(provider, "/runtime/release", {
    project_id: projectId,
    runtime_id: runtimeId,
    lease_id: leaseId,
  });
  assert.equal(released.status, 204);
  assert.equal(provider.currentRuntime(), null);
  assert.equal(processIsAlive(runtime.pid), false);
  assert.equal(processIsAlive(observation.descendantPid), false);

  const nextLeaseId = "55555555-5555-4555-8555-555555555555";
  const next = ensureBody({ lease_id: nextLeaseId });
  next.metadata._instafyManagedRuntimeLaunch.generation = nextLeaseId;
  assert.equal((await providerFetch(provider, "/runtime/ensure", next)).status, 200);
  const replacement = JSON.parse(await waitForFile(
    path.join(root, "runtimes", runtimeId, nextLeaseId, "workspace", "observed-env.json"),
  ));
  assert.notEqual(replacement.env.TMPDIR, observed.TMPDIR);
  assert.equal(path.dirname(replacement.env.TMPDIR), await realpath(root));
});

test("provider rejects a too-deep temporary root before launching any runtime", async t => {
  const { provider } = await fixture(t, { rootSuffix: "too-long-for-chromium-sockets-".repeat(3) });
  provider.setProject(projectId);
  assert.equal((await providerFetch(provider, "/runtime/ensure", ensureBody())).status, 500);
  assert.equal(provider.currentRuntime(), null);
  assert.equal(provider.diagnostics().launchStage, "temporary-path-check");
  assert.equal(provider.diagnostics().launches, 0);
});

test("provider rejects unconfigured projects, spoofed generations and environment launch authority", async t => {
  const { provider } = await fixture(t);
  assert.equal((await providerFetch(provider, "/runtime/ensure", ensureBody())).status, 503);
  provider.setProject(projectId);
  assert.throws(
    () => provider.setProject("66666666-6666-4666-8666-666666666666"),
    /already fixed/,
  );

  const wrongGeneration = ensureBody();
  wrongGeneration.metadata._instafyManagedRuntimeLaunch.generation =
    "77777777-7777-4777-8777-777777777777";
  assert.equal((await providerFetch(provider, "/runtime/ensure", wrongGeneration)).status, 409);

  const injected = ensureBody();
  injected.metadata.env.PATH = "/tmp/attacker";
  assert.equal((await providerFetch(provider, "/runtime/ensure", injected)).status, 400);

  const disabledPersistence = ensureBody();
  disabledPersistence.metadata.env.INSTAFY_BROWSER_PROFILE_PERSIST = "0";
  assert.equal((await providerFetch(provider, "/runtime/ensure", disabledPersistence)).status, 409);
  assert.equal(provider.currentRuntime(), null);
});

test("provider refuses to launch when a fixed browser helper port is already occupied", async t => {
  const blocker = createTcpServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: 9226, exclusive: true }, resolve);
  });
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const { provider } = await fixture(t);
  provider.setProject(projectId);
  const response = await providerFetch(provider, "/runtime/ensure", ensureBody());
  assert.equal(response.status, 500);
  assert.equal(provider.currentRuntime(), null);
});

test("bookkeeping cleanup requires an exact owned fixture marker", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "shared-studio-ownership-test-"));
  const providerRoot = path.join(directory, "provider");
  const fixedRoot = path.join(directory, "fixed");
  const browserRoot = path.join(fixedRoot, "playwright");
  await Promise.all([mkdir(providerRoot), mkdir(fixedRoot)]);
  await mkdir(browserRoot);
  const chromiumPid = path.join(browserRoot, "chromium.pid");
  const egressPid = path.join(browserRoot, "browser-egress-proxy.pid");
  await Promise.all([writeFile(chromiumPid, "123\n"), writeFile(egressPid, "124\n")]);
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await fixedBrowserDirectoryIsOwned(fixedRoot, providerRoot), false);
  assert.equal(await clearOwnedBrowserBookkeeping(fixedRoot, providerRoot), false);
  assert.equal(await readFile(chromiumPid, "utf8"), "123\n");
  assert.equal(await readFile(egressPid, "utf8"), "124\n");

  await writeFile(path.join(fixedRoot, "studio-e2e-owner.json"), JSON.stringify({
    runId: "55555555-5555-4555-8555-555555555555",
    root: await realpath(providerRoot),
  }), { mode: 0o600 });
  assert.equal(await fixedBrowserDirectoryIsOwned(fixedRoot, providerRoot), true);
  assert.equal(await clearOwnedBrowserBookkeeping(fixedRoot, providerRoot), true);
  await assert.rejects(readFile(chromiumPid), { code: "ENOENT" });
  await assert.rejects(readFile(egressPid), { code: "ENOENT" });
});

test("abort closes the provider and its owned runtime", async t => {
  const cancellation = new AbortController();
  const { provider } = await fixture(t, { signal: cancellation.signal });
  provider.setProject(projectId);
  assert.equal((await providerFetch(provider, "/runtime/ensure", ensureBody())).status, 200);
  const pid = provider.currentRuntime().pid;
  cancellation.abort();
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(processIsAlive(pid), false);
});
