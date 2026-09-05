#!/usr/bin/env node
// Secret-free Shared profile/runtime lifecycle, not full Studio/provisioner E2E.
// Docker is needed only by the caller that provisions migrated local Postgres.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const fixedRuntimeDirectory = "/tmp/instafy";
const fixedBrowserDirectory = "/tmp/instafy/playwright";
const controllerTest = "tests::browser_profile_e2e_fixture::shared_profile_browser_runtime_lifecycle_e2e";
const ownerPath = path.join(fixedRuntimeDirectory, "profile-e2e-owner.json");
const receiptPath = path.join(root, "packages/frontend/test-results/browser-ci/shared-profile/result.json");

export function validateBrowserFixtureEnvironment(env, platform = process.platform) {
  assert.equal(env.INSTAFY_PROFILE_E2E, "1", "browser helper requires the explicit lifecycle fixture marker");
  assert.equal(platform, "linux", "browser helper requires the owned Linux fixture");
  assert.match(env.INSTAFY_PLAYWRIGHT_CDP_PORT ?? "", /^[1-9][0-9]{0,4}$/, "explicit fixture CDP port required");
  assert.ok(Number(env.INSTAFY_PLAYWRIGHT_CDP_PORT) <= 65535, "invalid fixture CDP port");
  assert.match(env.INSTAFY_PROFILE_E2E_RUN_ID ?? "", /^[0-9a-f-]{36}$/, "owned fixture run identity required");
  assert.ok(env.INSTAFY_PROFILE_E2E_ROOT && path.isAbsolute(env.INSTAFY_PROFILE_E2E_ROOT), "owned fixture root required");
  assert.ok(env.INSTAFY_PLAYWRIGHT_PROFILE_DIR && path.isAbsolute(env.INSTAFY_PLAYWRIGHT_PROFILE_DIR), "owned fixture profile required");
  const relative = path.relative(env.INSTAFY_PROFILE_E2E_ROOT, env.INSTAFY_PLAYWRIGHT_PROFILE_DIR);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "browser profile must be inside this fixture's root");
}

async function verifyBrowserFixtureOwnership(env) {
  validateBrowserFixtureEnvironment(env);
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  assert.equal(owner.runId, env.INSTAFY_PROFILE_E2E_RUN_ID, "fixture owner does not match");
  assert.equal(owner.root, env.INSTAFY_PROFILE_E2E_ROOT, "fixture root does not match");
  const pid = (await readFile(path.join(fixedBrowserDirectory, "chromium.pid"), "utf8")).trim();
  assert.match(pid, /^[1-9][0-9]*$/, "fixture Chromium PID required");
  assert.ok(Number(pid) > 1, "invalid fixture Chromium PID");
  const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  assert.ok(args.includes(`--user-data-dir=${env.INSTAFY_PLAYWRIGHT_PROFILE_DIR}`), "PID does not own this fixture profile");
  assert.ok(args.includes(`--remote-debugging-port=${env.INSTAFY_PLAYWRIGHT_CDP_PORT}`), "PID does not own this fixture CDP port");
}

export function validateFixtureEnvironment(env, platform = process.platform) {
  assert.equal(platform, "linux", "real profile lifecycle requires hosted/disposable Linux");
  assert.ok(env.DISPLAY, "start this lane through xvfb-run (or a disposable X display)");
  assert.ok(env.TEST_DATABASE_URL, "explicit migrated disposable TEST_DATABASE_URL is required; no automatic DB fallback");
  const database = new URL(env.TEST_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(database.protocol), "Postgres fixture URL required");
  assert.equal(database.hostname, "127.0.0.1", "only a literal loopback database is permitted");
  assert.ok(database.port, "an explicit disposable database port is required");
  assert.equal(database.search, "", "database connection overrides are not permitted");
}

export function cargoTestArtifact(output, targetName, kind) {
  const artifacts = output.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter(item => item.reason === "compiler-artifact" && item.profile?.test
    && item.target?.name === targetName && item.target?.kind?.includes(kind) && item.executable);
  assert.equal(artifacts.length, 1, `expected exactly one compiled ${targetName} test executable`);
  return artifacts[0].executable;
}

export function fixtureChildEnvironment(env) {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP",
    "CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR", "CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG", "CARGO_BUILD_JOBS",
    "RUSTC", "RUSTFLAGS", "RUSTDOCFLAGS", "RUSTUP_TOOLCHAIN", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "PLAYWRIGHT_BROWSERS_PATH"];
  return Object.fromEntries(allowed.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

export async function copyFixtureEntrypoint(binDirectory) {
  const destination = path.join(binDirectory, "runtime-entrypoint");
  // Docker makes the checked-in 0644 script executable while copying it into
  // the image. Native CI must do the same only for its fresh owned copy, never
  // chmod the checkout or silently replace an existing launcher.
  await copyFile(path.join(root, "docker/runtime/entrypoint.sh"), destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o700);
  return destination;
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function terminateGroup(pid) {
  signalGroup(pid, "SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 250));
  signalGroup(pid, "SIGKILL");
}

export function installCancellationSignalHandlers(cancellation, emitter = process) {
  const interrupt = () => cancellation.abort();
  emitter.once("SIGINT", interrupt);
  emitter.once("SIGTERM", interrupt);
  return () => {
    emitter.removeListener("SIGINT", interrupt);
    emitter.removeListener("SIGTERM", interrupt);
  };
}

// Builds and browser fixtures use the same cancellable, privately owned process
// group mechanism. No synchronous build can postpone SIGINT/SIGTERM cleanup.
export async function runOwnedProcess(command, args, { env, cwd = root, signal,
  timeoutMs = 25 * 60_000, onOutput } = {}) {
  const child = spawn(command, args, { cwd, env, signal, detached: true,
    stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  let overflow = false;
  child.stdout.on("data", data => {
    onOutput?.(data);
    if (output.length + data.length > 64 * 1024 * 1024) {
      overflow = true;
      if (child.pid) signalGroup(child.pid, "SIGKILL");
    } else output += data;
  });
  const timeout = setTimeout(() => { if (child.pid) signalGroup(child.pid, "SIGKILL"); }, timeoutMs);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.ok(!overflow, `${command} exceeded bounded output`);
    assert.equal(status, 0, `${command} failed`);
    return output;
  } finally {
    clearTimeout(timeout);
    // Also catches helpers orphaned by a successful parent (Chromium/proxy).
    if (child.pid) await terminateGroup(child.pid);
  }
}

function playwrightPackage() {
  const frontend = createRequire(path.join(root, "packages/frontend/package.json"));
  const playwrightTest = createRequire(frontend.resolve("@playwright/test/package.json"));
  return playwrightTest.resolve("playwright");
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function browserAction(mode, value = "") {
  assert.ok(["ready", "seed", "check", "empty", "close"].includes(mode), "unknown browser fixture action");
  assert.match(value, /^[a-z-]*$/, "only inert fixture values are accepted");
  await verifyBrowserFixtureOwnership(process.env);
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPackage());
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.INSTAFY_PLAYWRIGHT_CDP_PORT}`, { timeout: 15_000 });
  if (mode === "close") {
    const session = await browser.newBrowserCDPSession();
    try { await session.send("Browser.close"); } catch (error) {
      if (!/closed|disconnect/i.test(String(error))) throw error;
    }
    return;
  }
  if (mode === "ready") return;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://profile-fixture.test");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/echo") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    } else {
      if (url.pathname === "/seed") {
        const seed = url.searchParams.get("value");
        if (!seed || !/^[a-z-]+$/.test(seed)) { response.writeHead(400).end(); return; }
        response.setHeader("Set-Cookie", `fixture_http=${seed}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600`);
      }
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Disposable browser persistence fixture</title><p>Inert test page</p>");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const context = browser.contexts()[0];
  assert.ok(context, "production Chromium must expose its persistent default context");
  // Explicit test-only transport bridge. The browser's public-only egress
  // proxy remains enabled/unmodified. Actual HTTP fixture responses set cookies
  // in Chromium, and the server echoes Cookie headers actually sent by Chromium.
  // This proves storage, not the browser network transport/egress boundary.
  await context.route("http://profile-fixture.test/**", async route => {
    const original = new URL(route.request().url());
    const headers = await route.request().allHeaders();
    // headers() omits Cookie/security headers. Also explicitly forward an empty
    // Cookie header so APIRequestContext cannot substitute its loopback jar.
    headers.cookie ??= "";
    const response = await route.fetch({ url: `${localOrigin}${original.pathname}${original.search}`,
      headers, timeout: 10_000, maxRedirects: 0 });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  try {
    await page.goto(`http://profile-fixture.test/${mode === "seed" ? `seed?value=${value}` : "check"}`, { timeout: 15_000 });
    if (mode === "seed") {
      await page.evaluate(seed => {
        document.cookie = `fixture_js=${seed}; Path=/; SameSite=Lax; Max-Age=3600`;
        localStorage.setItem("fixture_login", seed);
      }, value);
    }
    const observed = await page.evaluate(async () => ({
      visible: document.cookie,
      storage: localStorage.getItem("fixture_login"),
      echo: await (await fetch("/echo")).json(),
    }));
    const cookies = await context.cookies("http://profile-fixture.test/");
    if (mode === "empty") {
      assert.equal(observed.storage, null);
      assert.equal(observed.echo.cookie, "");
      assert.equal(cookies.length, 0);
    } else {
      assert.equal(observed.storage, value);
      assert.ok(observed.visible.includes(`fixture_js=${value}`));
      assert.ok(!observed.visible.includes("fixture_http="), "HttpOnly cookie must not be visible to page JS");
      assert.ok(observed.echo.cookie.includes(`fixture_http=${value}`), "server must receive restored HttpOnly cookie");
      assert.ok(observed.echo.cookie.includes(`fixture_js=${value}`), "server must receive restored JS cookie");
      assert.equal(cookies.find(cookie => cookie.name === "fixture_http")?.httpOnly, true);
    }
  } finally {
    await page.close();
    await context.unrouteAll({ behavior: "wait" });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function lifecycle() {
  validateFixtureEnvironment(process.env);
  const env = fixtureChildEnvironment(process.env);
  const playwright = playwrightPackage();
  const temporary = await mkdtemp(path.join(tmpdir(), "instafy-profile-e2e-"));
  let claimedFixedDirectory = false;
  let passed = false;
  let stage = "setup";
  const started = Date.now();
  const cancellation = new AbortController();
  const removeSignalHandlers = installCancellationSignalHandlers(cancellation);
  const run = (command, args, options = {}) => runOwnedProcess(command, args, {
    env, signal: cancellation.signal, ...options,
  });
  try {
    // Never erase or attach to a developer's existing browser resources.
    // The launch helper also writes its egress log in /tmp/instafy, so claim
    // that entire fresh fixture directory or refuse before touching anything.
    await mkdir(fixedRuntimeDirectory);
    claimedFixedDirectory = true;
    await mkdir(fixedBrowserDirectory);
    const runId = randomUUID();
    await writeFile(ownerPath, JSON.stringify({ runId, root: temporary }), { mode: 0o600, flag: "wx" });
    const bin = path.join(temporary, "bin");
    await mkdir(bin);
    const entrypoint = await copyFixtureEntrypoint(bin);
    stage = "build-egress-helper";
    await run("go", ["build", "-o", path.join(bin, "browser-egress-proxy"), "."], { cwd: path.join(root, "packages/browser-egress-proxy") });
    const supportedChromium = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
    let found = false;
    for (const candidate of supportedChromium) {
      try { await access(candidate, constants.X_OK); found = true; break; } catch {}
    }
    assert.ok(found, "existing production launch helper requires /usr/bin/chromium or /usr/bin/google-chrome (runner-only symlink to Playwright Chromium is supported)");
    stage = "build-runtime-fixture";
    const agent = cargoTestArtifact(await run("cargo", ["test", "--locked", "--manifest-path", "packages/runtime-agent/Cargo.toml", "--test", "browser_profile_e2e", "--no-run", "--message-format=json"]), "browser_profile_e2e", "test");
    stage = "build-controller-fixture";
    const controller = cargoTestArtifact(await run("cargo", ["test", "--locked", "--manifest-path", "packages/runtime-controller/Cargo.toml", "--bin", "runtime-controller", "--no-run", "--message-format=json"]), "runtime-controller", "bin");
    const runEnv = { ...env,
      PATH: `${bin}:${env.PATH}`,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      NODE_PATH: path.dirname(path.dirname(playwright)),
      INSTAFY_PROFILE_E2E: "1",
      INSTAFY_PROFILE_E2E_ROOT: temporary,
      INSTAFY_PROFILE_E2E_RUN_ID: runId,
      INSTAFY_PROFILE_E2E_AGENT_BINARY: agent,
      INSTAFY_PROFILE_E2E_SCRIPT: script,
      INSTAFY_ENABLE_BROWSER_SESSION: "1",
      INSTAFY_BROWSER_PROFILE_PERSIST: "1",
      INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS: "0",
      INSTAFY_RUNTIME_ENTRYPOINT: entrypoint,
      INSTAFY_PLAYWRIGHT_CDP_PORT: String(await freePort()),
      INSTAFY_BROWSER_EGRESS_PROXY_BIND: `127.0.0.1:${await freePort()}`,
      INSTAFY_BROWSER_EGRESS_ISOLATION: "1",
      INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV: "0",
      INSTAFY_BROWSER_ADBLOCK: "0",
      WORKSPACE_DIR: path.join(temporary, "workspace"),
    };
    stage = "real-browser-lifecycle";
    const output = await run(controller, [controllerTest, "--exact", "--ignored", "--nocapture", "--test-threads=1"], {
      env: runEnv, timeoutMs: 240_000, onOutput: data => process.stdout.write(data),
    });
    assert.ok(output.includes("PROFILE_E2E_RUNTIME_OK:"), "runtime browser scenario did not execute (zero tests/skips are failures)");
    assert.ok(output.includes("PROFILE_E2E_CONTROLLER_OK:"), "controller fixture did not execute");
    passed = true;
    console.log("Shared profile/runtime lifecycle passed; full Studio/collaboration and browser egress transport are outside this lane.");
  } finally {
    try {
      if (claimedFixedDirectory) await rm(fixedRuntimeDirectory, { recursive: true });
      await rm(temporary, { recursive: true });
      await mkdir(path.dirname(receiptPath), { recursive: true });
      // Fixed, credential-free receipt only. Never retain profiles, tokens,
      // request bodies, browser traces, DB URLs, or arbitrary error text.
      await writeFile(receiptPath, `${JSON.stringify({
        schemaVersion: 1, lane: "shared-profile-runtime-lifecycle", status: passed ? "passed" : "failed",
        stage, durationMs: Date.now() - started,
        proof: passed ? ["real-chromium-http-only-and-js-cookies", "server-cookie-echo", "local-storage", "runtime-profile-replacement", "encrypted-controller-storage", "stale-writer-409", "authorized-reset", "released-lease-no-resurrection"] : [],
        excludes: ["full-studio", "collaboration", "model-turns", "active-provider-stop", "browser-egress-transport", "OS-isolation"],
      }, null, 2)}\n`);
    } finally { removeSignalHandlers(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === "--help") {
      console.log("Usage: TEST_DATABASE_URL=postgresql://...@127.0.0.1:<port>/postgres xvfb-run -a node scripts/browser-profile-e2e.mjs\nRequires Linux, migrated disposable Postgres, Go, Rust, pnpm-installed frontend Playwright and a supported Chromium binary. No model/production credentials are used.");
    } else if (process.argv[2] === "browser") {
      await browserAction(process.argv[3], process.argv[4]);
    } else {
      assert.equal(process.argv.length, 2, "unknown profile lifecycle arguments");
      await lifecycle();
    }
    // CDP disconnects without Browser.close except in the explicit close mode.
    process.exit(0);
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exit(1);
  }
}
