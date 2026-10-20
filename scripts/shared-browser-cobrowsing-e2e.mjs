import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// Real-browser tool-protocol proof, not a model/Studio/runtime-guard fixture.
// All pages, identities, inputs, approvals and profile files are disposable.
// No environment loaders, real accounts, controller or external sites are used.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(path.join(repositoryRoot, "packages/frontend/package.json"));
const playwrightRequire = createRequire(frontendRequire.resolve("@playwright/test"));
const { chromium } = playwrightRequire("playwright");
const playwrightDirectory = fs.realpathSync(path.dirname(playwrightRequire.resolve("playwright/package.json")));
const executablePath = chromium.executablePath();
const resultDirectory = path.join(repositoryRoot, "packages/frontend/test-results/browser-ci/shared-cobrowsing");
// Composed exactly as runtime-agent's embedded_shared_browser_script(): the
// browser-action-policy scripts publish their API on globalThis, then the
// approval protocol and controller follow. The runtime passes it on stdin.
const policyScript = (name) => `(function (module, require) {\n${
  fs.readFileSync(path.join(repositoryRoot, "packages/browser-action-policy", name), "utf8")
}\n})(undefined, undefined);`;
const scriptSource = [
  policyScript("redaction.js"),
  policyScript("actionPolicy.js"),
  ...["shared-browser-approval.js", "shared-browser-cli.js"]
    .map((name) => fs.readFileSync(path.join(repositoryRoot, "packages/runtime-agent/assets", name), "utf8")),
].join("\n");
const entrypointSource = fs.readFileSync(path.join(repositoryRoot, "docker/runtime/entrypoint.sh"), "utf8");
// Inert canary in the page text; it must never reach tool output or telemetry.
// Assembled at run time so the source holds no key-shaped literal.
const CANARY = ["sk", "test", "INSTAFYCANARY0123456789abcdef"].join("_");
const SAMPLE_COUNT = 5;

export function fixtureEnvironment(source, directory) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  return {
    ...env,
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    CI: "1",
  };
}

const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Disposable co-browsing fixture</title>
<style>body{font:18px system-ui;max-width:780px;margin:40px auto;padding:16px;background:#f8fafc;color:#172033}label{display:block;margin:22px 0}input{display:block;width:90%;padding:10px;margin-top:6px;font:inherit;border:1px solid #94a3b8;border-radius:6px}button{padding:10px 18px;font:inherit}#extra{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}#extra button{font-size:12px;padding:4px}</style>
<h1>Human input handoff</h1><p>This is an isolated test page with inert values.</p>
<label>Search<input id="query" aria-label="Search" autocomplete="off"></label>
<label>Display name<input id="display-name" aria-label="Display name" autocomplete="off" style="outline:1px solid rgb(100, 116, 139);outline-offset:1px"></label>
<label>Verification code<input id="verification-code" aria-label="Verification code" type="password" autocomplete="one-time-code"></label>
<form id="details-form"><button id="details" type="button">Show details</button> <output id="count">0</output></form><section id="extra"></section>
<p id="note">Order note ${CANARY}</p><a id="export" href="/export.csv" download>Export CSV</a>
<script>document.getElementById('details').onclick=()=>{const output=document.getElementById('count');output.textContent=String(Number(output.textContent)+1)};</script>
</html>`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listenFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/export.csv") {
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": "attachment; filename=inert-export.csv",
        "cache-control": "no-store",
      });
      response.end("inert,fixture\n1,2\n");
      return;
    }
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixtureHtml);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

// Runs the runtime entrypoint's own block_browser_downloads on a profile.
function blockDownloadsInProfile(profileDirectory, environment) {
  const start = entrypointSource.indexOf("\nblock_browser_downloads() {\n");
  const end = entrypointSource.indexOf("\n}\n", start + 1);
  assert.ok(start >= 0 && end > start, "The runtime entrypoint must define block_browser_downloads");
  const result = spawnSync("bash", ["-c", `${entrypointSource.slice(start + 1, end + 3)}\nblock_browser_downloads "$1"`, "block", profileDirectory], {
    env: environment, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, `block_browser_downloads failed: ${result.stderr}`);
}

// Regular files under a directory whose content is the fixture export.
function exportedCopies(directory) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && fs.statSync(entryPath).size < 4096
        && fs.readFileSync(entryPath, "utf8").includes("inert,fixture")) found.push(entryPath);
    }
  };
  visit(directory);
  return found;
}

class RawCdp {
  constructor(url) { this.url = url; this.nextId = 0; this.pending = new Map(); }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id ? this.pending.get(message.id) : null;
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async close() {
    this.socket.close();
    await delay(300);
  }
}

// Which download block survives the end of a controller connection and a
// viewer's trusted click? Plain Chromium, with no Playwright connection that
// would install its own download behavior. A controller session denies
// downloads and disconnects; a second session then clicks the export link the
// way viewer input arrives.
async function downloadAfterReconnect({ temporary, environment, siteUrl, profileBlocked }) {
  const root = fs.mkdtempSync(path.join(temporary, profileBlocked ? "download-blocked-" : "download-control-"));
  const profile = path.join(root, "profile");
  const downloads = path.join(root, "downloads");
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloads },
  }));
  if (profileBlocked) blockDownloadsInProfile(profile, environment);
  const browser = spawn(executablePath, [
    // The same isolation flags Playwright passes: no OS keychain or password store.
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox",
    "--use-mock-keychain", "--password-store=basic",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { env: environment, stdio: "ignore" });
  try {
    let port;
    for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
      try {
        port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    assert.ok(Number.isInteger(port) && port > 0, "Plain Chromium did not expose its loopback CDP port");
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const controller = await new RawCdp(version.webSocketDebuggerUrl).open();
    await controller.send("Browser.setDownloadBehavior", { behavior: "deny" });
    await controller.close();
    let pageTarget;
    for (let attempt = 0; attempt < 100 && !pageTarget; attempt += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      pageTarget = targets.find((target) => target.type === "page");
      if (!pageTarget) await delay(50);
    }
    assert.ok(pageTarget, "Plain Chromium did not open the fixture page");
    const viewer = await new RawCdp(pageTarget.webSocketDebuggerUrl).open();
    await viewer.send("Page.navigate", { url: siteUrl });
    let box;
    for (let attempt = 0; attempt < 100 && !box; attempt += 1) {
      const evaluated = await viewer.send("Runtime.evaluate", {
        expression: "(() => { const link = document.getElementById('export'); if (!link) return null; link.scrollIntoView(); const r = link.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
        returnByValue: true,
      });
      box = evaluated.result.value;
      if (!box) await delay(50);
    }
    assert.ok(box, "The export link did not render");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await viewer.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await delay(2_500);
    await viewer.close();
    return exportedCopies(root).length > 0 ? "downloaded" : "blocked";
  } finally {
    browser.kill("SIGKILL");
    await delay(200);
  }
}

function timingSummary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: Math.round(sorted[0]),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    maxMs: Math.round(sorted.at(-1)),
  };
}

export async function runSharedBrowserCobrowsingFixture() {
  fs.mkdirSync(resultDirectory, { recursive: true });
  for (const name of ["result.json", "highlighted-fields.png", "highlighted-fields-mobile.png"]) {
    fs.rmSync(path.join(resultDirectory, name), { force: true });
  }
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cobrowsing-e2e-")));
  const profileDirectory = path.join(temporary, "profile");
  const approvalDirectory = path.join(temporary, "approvals");
  const markerPath = path.join(temporary, "agent-control.json");
  const actionsPath = path.join(temporary, "actions.jsonl");
  const driverDownloads = path.join(temporary, "driver-downloads");
  fs.mkdirSync(approvalDirectory, { mode: 0o700 });
  const environment = fixtureEnvironment(process.env, temporary);
  // The runtime entrypoint blocks downloads in the profile before every launch.
  blockDownloadsInProfile(profileDirectory, environment);
  const children = new Set();
  const servers = [];
  let context;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    for (const child of children) child.kill("SIGKILL");
    void context?.close().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const firstSite = await listenFixture();
    servers.push(firstSite.server);
    const secondSite = await listenFixture();
    servers.push(secondSite.server);
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      viewport: { width: 1100, height: 900 },
      acceptDownloads: true,
      downloadsPath: driverDownloads,
      env: environment,
      args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
    });
    const allowedOrigins = new Set([new URL(firstSite.url).origin, new URL(secondSite.url).origin]);
    await context.route("**/*", (route) => allowedOrigins.has(new URL(route.request().url()).origin)
      ? route.continue()
      : route.abort());
    const page = context.pages()[0];
    await page.goto(firstSite.url);
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.detach();
    const pageId = targetInfo.targetId;
    let port;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        port = Number(fs.readFileSync(path.join(profileDirectory, "DevToolsActivePort"), "utf8").split("\n")[0]);
        if (Number.isInteger(port) && port > 0 && port < 65536) break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "Owned Chromium did not expose its loopback CDP port");
    let authority;
    function freshTurn() {
      assert.equal(children.size, 0, "A fresh fixture turn requires previous CLI process exit");
      for (const name of ["request.json", "decision.json", "state.json"]) {
        fs.rmSync(path.join(approvalDirectory, name), { force: true });
      }
      authority = {
        version: 2, ownerId: randomUUID(), runId: randomUUID(),
        initiatorUserId: "00000000-0000-4000-8000-000000000003",
        browserPageId: pageId, displayName: "Fixture assistant", expiresAtMs: Date.now() + 300_000,
      };
      writeProtectedJson(markerPath, authority);
    }
    freshTurn();
    const observedApprovals = [];
    async function runTool(method, requestPath, body, decision = null, beforeDecision = null) {
      assert.equal(interrupted, false, "Fixture interrupted");
      const started = performance.now();
      const child = spawn(process.execPath, ["-", method, requestPath, ...(body ? [JSON.stringify(body)] : [])], {
        cwd: temporary,
        env: {
          ...environment,
          INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: playwrightDirectory,
          INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.dirname(playwrightDirectory),
          INSTAFY_SHARED_BROWSER_PAGE_ID: pageId,
          INSTAFY_PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${port}`,
          INSTAFY_BROWSER_AGENT_CONTROL_FILE: markerPath,
          INSTAFY_SHARED_BROWSER_APPROVAL_DIR: approvalDirectory,
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "5000",
          INSTAFY_BROWSER_ACTIONS_FILE: actionsPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.stdin.end(scriptSource);
      let stdout = "";
      let stderr = "";
      let failure;
      const seen = new Set();
      function collect(chunk, output) {
        if (stdout.length + stderr.length + chunk.length > 2 * 1024 * 1024) {
          failure = new Error("Fixture tool exceeded its output limit");
          child.kill("SIGKILL");
        } else if (output === "stdout") stdout += chunk;
        else stderr += chunk;
      }
      child.stdout.on("data", (chunk) => collect(chunk.toString(), "stdout"));
      child.stderr.on("data", (chunk) => collect(chunk.toString(), "stderr"));
      const approvalTimer = setInterval(async () => {
        try {
          const request = JSON.parse(fs.readFileSync(path.join(approvalDirectory, "request.json"), "utf8"));
          if (seen.has(request.approvalId)) return;
          seen.add(request.approvalId);
          observedApprovals.push({ kind: request.kind, operation: request.operation });
          assert.ok(decision, `Unexpected ${request.kind} approval during ${requestPath}`);
          assert.equal(request.kind, decision === "allow_once" ? "action" : "origin",
            "Routine grants require an origin prompt; one-shot decisions require an action prompt");
          if (beforeDecision) await beforeDecision(request);
          writeProtectedJson(path.join(approvalDirectory, "decision.json"), {
            version: 1, approvalId: request.approvalId, requestFingerprint: request.requestFingerprint,
            decision, decidedByUserId: authority.initiatorUserId,
            decidedAtMs: Date.now(), expiresAtMs: request.expiresAtMs,
          });
        } catch (error) {
          if (error.code === "ENOENT") return;
          failure = error;
          child.kill("SIGKILL");
        }
      }, 10);
      const timeout = setTimeout(() => {
        failure = new Error(`Fixture tool timed out: ${requestPath}`);
        child.kill("SIGKILL");
      }, 20_000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (failure) throw failure;
        return { code, stdout, stderr, wallMs: performance.now() - started };
      } finally {
        clearInterval(approvalTimer);
        clearTimeout(timeout);
        children.delete(child);
      }
    }
    async function successfulTool(method, requestPath, body, decision = null) {
      const result = await runTool(method, requestPath, body, decision);
      assert.equal(result.code, 0, `Production tool failed at ${requestPath}: ${result.stderr}`);
      return { ...result, payload: JSON.parse(result.stdout) };
    }
    function target(snapshot, label) {
      const element = snapshot.interactiveElements.find((entry) => entry.label === label);
      assert.ok(element, `Observed element is missing: ${label}`);
      return { index: element.index, snapshotId: snapshot.snapshotId };
    }

    let snapshot = (await successfulTool("GET", "/v1/snapshot", null, "allow_routine")).payload;
    assert.equal(observedApprovals.length, 1);
    // Page text is masked on every site in every mode; the canary never leaves.
    assert.ok(!JSON.stringify(snapshot).includes("INSTAFYCANARY"), "A page secret reached the snapshot");
    assert.match(snapshot.visibleText, /Order note \[redacted secret\]/);
    assert.equal(snapshot.secretScreen, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(approvalDirectory, "state.json"), "utf8")).routineBrowsingAllowed, true);
    // A genuinely different loopback origin proves no repeated origin prompt.
    snapshot = (await successfulTool("POST", "/v1/navigate", { url: secondSite.url })).payload;
    snapshot = (await successfulTool("POST", "/v1/type", { ...target(snapshot, "Search"), text: "inert search text" })).payload;
    assert.equal(await page.locator("#query").inputValue(), "inert search text");
    snapshot = (await successfulTool("POST", "/v1/click", target(snapshot, "Show details"))).payload;
    assert.equal(await page.locator("#count").textContent(), "1");
    assert.equal(observedApprovals.length, 1, "Routine read/navigation/click/type repeated the initial prompt");

    const fields = ["Display name", "Verification code"].map((label) => target(snapshot, label).index);
    const handoff = await runTool("POST", "/v1/request-human-input", { indices: fields, snapshotId: snapshot.snapshotId });
    assert.equal(handoff.code, 1, "Handoff must stop the tool turn rather than report continued control");
    assert.match(handoff.stderr, /\[human_input_required_non_retryable\]/);
    const actionLog = fs.readFileSync(actionsPath, "utf8").trim().split("\n").map(JSON.parse);
    const guidance = actionLog.filter((action) => action.type === "human_input");
    assert.equal(guidance.length, 1);
    assert.equal(guidance[0].pageId, pageId);
    assert.equal(guidance[0].humanInputRequest.runId, authority.runId);
    assert.equal(guidance[0].humanInputRequest.initiatorUserId, authority.initiatorUserId);
    assert.deepEqual(guidance[0].humanInputRequest.fields, [{ label: "Highlighted field 1" }, { label: "Highlighted field 2" }]);
    for (const selector of ["#display-name", "#verification-code"]) {
      assert.equal(await page.locator(selector).inputValue(), "", "Requesting input must not fill a field");
      assert.equal(await page.locator(selector).evaluate((element) => getComputedStyle(element).outlineWidth), "3px");
    }
    fs.mkdirSync(resultDirectory, { recursive: true });
    await page.screenshot({ path: path.join(resultDirectory, "highlighted-fields.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#verification-code").scrollIntoViewIfNeeded();
    for (const selector of ["#display-name", "#verification-code"]) {
      assert.equal(await page.locator(selector).evaluate((element) => getComputedStyle(element).outlineWidth), "3px");
    }
    await page.screenshot({ path: path.join(resultDirectory, "highlighted-fields-mobile.png") });
    await page.setViewportSize({ width: 1100, height: 900 });

    // There is no runtime/model process in this fixture. We wait for actual CLI
    // exit, then the human driver fills inert values. This does NOT prove the
    // Rust shutdown guard or Studio's exclusive-driver transition.
    assert.equal(children.size, 0);
    await page.locator("#display-name").fill("Fixture visitor");
    await page.locator("#verification-code").fill("INERT-TEST-CODE");
    freshTurn();
    // The same DOM descriptors and indices are not an observation in the new
    // run. Even a fresh routine grant cannot revive the pre-handoff snapshot.
    const stale = await runTool("POST", "/v1/click", target(snapshot, "Show details"), "allow_routine");
    assert.equal(stale.code, 1, "A prior-run snapshot must be rejected on an unchanged page");
    assert.match(stale.stderr, /snapshot is stale/);
    assert.equal(await page.locator("#count").textContent(), "1", "Stale continuation changed the page");
    const continued = await successfulTool("GET", "/v1/snapshot");
    assert.notEqual(continued.payload.snapshotId, snapshot.snapshotId, "Fresh control authority must change snapshot identity");
    assert.equal(observedApprovals.length, 2, "Fresh run must request a new scoped grant");
    assert.equal(await page.locator("#display-name").inputValue(), "Fixture visitor");
    assert.equal(await page.locator("#verification-code").inputValue(), "INERT-TEST-CODE");
    assert.equal(await page.locator("#display-name").evaluate((element) => element.style.outlineWidth), "1px");
    assert.equal(await page.locator("#display-name").evaluate((element) => element.style.outlineOffset), "1px");
    assert.equal(await page.locator("#verification-code").evaluate((element) => element.style.outline), "");
    assert.ok(!continued.stdout.includes("INERT-TEST-CODE"));
    assert.ok(!continued.stderr.includes("INERT-TEST-CODE"));
    assert.ok(!fs.readFileSync(actionsPath, "utf8").includes("INERT-TEST-CODE"));

    const measurements = [];
    for (const [name, extraControls] of [["small-page", 0], ["moderate-page", 48]]) {
      await page.locator("#extra").evaluate((element, count) => {
        element.replaceChildren();
        for (let index = 0; index < count; index += 1) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `Detail ${index + 1}`;
          element.append(button);
        }
      }, extraControls);
      const snapshots = [];
      const clicks = [];
      let interactiveElements = 0;
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const observed = await successfulTool("GET", "/v1/snapshot");
        interactiveElements = observed.payload.interactiveElements.length;
        snapshots.push(observed.wallMs);
        const clicked = await successfulTool("POST", "/v1/click", target(observed.payload, "Show details"));
        clicks.push(clicked.wallMs);
      }
      measurements.push({ name, interactiveElements, snapshot: timingSummary(snapshots), click: timingSummary(clicks) });
    }
    assert.equal(observedApprovals.length, 2, "Routine benchmark calls unexpectedly prompted");
    // Native button.type distinguishes inert form buttons from true submission
    // controls, including the browser's default for missing/invalid type values.
    // Every submission below is explicitly approved before its local handler runs.
    await page.locator("#details-form").evaluate((form) => {
      form.dataset.submissions = "0";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        form.dataset.submissions = String(Number(form.dataset.submissions) + 1);
      });
      // "Clear" names a destructive step in the shared step categories, so the
      // inert reset control carries a neutral label.
      const reset = document.createElement("button");
      reset.type = "reset";
      reset.textContent = "Show all";
      form.append(reset);
    });
    const resetSnapshot = (await successfulTool("GET", "/v1/snapshot")).payload;
    assert.equal(resetSnapshot.interactiveElements.find((entry) => entry.label === "Show details").inputType, "button");
    assert.equal(resetSnapshot.interactiveElements.find((entry) => entry.label === "Show all").inputType, "reset");
    await successfulTool("POST", "/v1/click", target(resetSnapshot, "Show all"));
    assert.equal(observedApprovals.length, 2, "A non-submitting form button repeated approval");
    let expectedSubmissions = 0;
    for (const type of ["submit", null, "unrecognized-type"]) {
      await page.locator("#details-form").evaluate((form, requestedType) => {
        form.querySelector("#apply-filter")?.remove();
        const button = document.createElement("button");
        button.id = "apply-filter";
        if (requestedType !== null) button.setAttribute("type", requestedType);
        button.textContent = "Apply filter";
        form.append(button);
      }, type);
      const observed = (await successfulTool("GET", "/v1/snapshot")).payload;
      assert.equal(observed.interactiveElements.find((entry) => entry.label === "Apply filter").inputType, "submit");
      const approved = await runTool("POST", "/v1/click", target(observed, "Apply filter"), "allow_once", async (request) => {
        assert.equal(request.operation, "click");
        assert.equal(await page.locator("#details-form").getAttribute("data-submissions"), String(expectedSubmissions),
          "The form must remain unchanged while its action confirmation is pending");
      });
      assert.equal(approved.code, 0, `Approved form button failed: ${approved.stderr}`);
      expectedSubmissions += 1;
      assert.equal(await page.locator("#details-form").getAttribute("data-submissions"), String(expectedSubmissions));
      assert.equal(observedApprovals.length, 2 + expectedSubmissions, "Each form submission needs its own action confirmation");
    }
    // A download link asks under routine with its category in the label, and
    // even an approved download never lands: the controller denies downloads
    // for its connection, and the profile blocks them after it.
    const exportSnapshot = (await successfulTool("GET", "/v1/snapshot")).payload;
    const exported = await runTool("POST", "/v1/click", target(exportSnapshot, "Export CSV"), "allow_once", async (request) => {
      assert.equal(request.operation, "click");
      assert.equal(request.display.label, "Download or export: Export CSV");
    });
    assert.equal(exported.code, 0, `Approved export click failed: ${exported.stderr}`);
    assert.equal(observedApprovals.length, 2 + expectedSubmissions + 1, "The export link must ask under routine");
    await delay(2_500);
    assert.deepEqual(exportedCopies(temporary), [], "An approved agent click downloaded a file");
    const actionTelemetry = fs.readFileSync(actionsPath, "utf8");
    assert.ok(!actionTelemetry.includes("INSTAFYCANARY"), "A page secret reached the action log");

    const downloadSite = await listenFixture();
    servers.push(downloadSite.server);
    const downloads = {
      // The control: without the profile block, a controller's deny ends with
      // its connection and a viewer's click downloads.
      sessionDenyAfterReconnect: await downloadAfterReconnect({ temporary, environment, siteUrl: downloadSite.url, profileBlocked: false }),
      // The entrypoint's profile preference survives the reconnect.
      profileBlockAfterReconnect: await downloadAfterReconnect({ temporary, environment, siteUrl: downloadSite.url, profileBlocked: true }),
    };
    assert.equal(downloads.sessionDenyAfterReconnect, "downloaded", "The download control did not download; the proof cannot tell blocks apart");
    assert.equal(downloads.profileBlockAfterReconnect, "blocked", "The profile download block did not survive a reconnect and viewer click");

    const result = {
      status: "passed", fixtureVersion: 1, browserVersion: context.browser()?.version() ?? "unknown",
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      assertions: {
        realChromium: true, productionToolScripts: true, explicitRoutineGrant: true,
        crossOriginRoutineNavigation: true, routineClickAndType: true,
        fieldHighlights: true, fieldHighlightsSurviveReflow: true, handoffTerminatesTool: true, inertHumanFill: true,
        freshTurnClearsHighlights: true, previousRunSnapshotRejected: true,
        secretValueAbsentFromToolOutputAndTelemetry: true,
        routineNonSubmittingFormButtons: true, formSubmissionControlsRequireConfirmation: true,
        pageSecretsMasked: true, downloadLinkAsksWithCategory: true, approvedAgentDownloadDenied: true,
        profileDownloadBlockSurvivesReconnect: true,
      },
      measurements,
      downloads,
      limitations: [
        "Synthetic loopback pages, one headless browser, five samples per operation and page size; no latency SLA.",
        "Wall time includes fresh Node process, Playwright/CDP attachment and production settle/snapshot work.",
        "No model, Studio UI, runtime shutdown guard, origin driver lease, egress policy or remote-video proof.",
      ],
    };
    fs.writeFileSync(path.join(resultDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    for (const child of children) child.kill("SIGKILL");
    await context?.close().catch(() => {});
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-cobrowsing-e2e.mjs (no filters or skips)");
  runSharedBrowserCobrowsingFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(path.join(resultDirectory, "result.json"), `${JSON.stringify({ status: "failed", fixtureVersion: 1 })}\n`);
    console.error(error.message);
    process.exitCode = 1;
  });
}
