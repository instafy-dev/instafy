import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));
const pageBridge = require(path.join(packageRoot, "dist/personalBrowserPageBridge.js"));
const humanInput = require(path.join(packageRoot, "dist/personalBrowserHumanInput.js"));
const control = require(path.join(packageRoot, "dist/personalBrowserControlServer.js"));
const hostCode = ts.transpileModule(
  fs.readFileSync(path.join(packageRoot, "src/personalBrowserHost.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

async function waitForStart(started) {
  for (let attempt = 0; attempt < 100 && !started(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(started(), "The inert native operation did not start");
}

async function fixture(highlight = async () => true, options = {}) {
  const pauses = [];
  const highlights = [];
  const shieldStates = [];
  const timers = [];
  let clears = 0;
  class ControlServer {
    credentials = null;
    getCredentials() { return this.credentials; }
    async bindProject(projectId) { this.credentials = { projectId }; }
    clearBinding() { this.credentials = null; }
  }
  const descriptor = { found: true, disabled: false, identity: "fixture-document:1", tag: "input", type: "password", name: "Verification code" };
  const module = { exports: {} };
  const dependencies = {
    electron: { WebContentsView: class {}, dialog: { showMessageBox: async () => ({ response: 1 }) } },
    "./personalBrowserSecurity": security,
    "./personalBrowserPageBridge": {
      ...pageBridge,
      snapshotPersonalBrowserPage: async () => ({
        url: "https://example.test/", title: "Disposable fixture", text: "Verification code", documentToken: "fixture-document", capturedAt: new Date().toISOString(),
        interactive: [{ index: 0, tag: "input", type: "password", name: "Verification code", disabled: false, identity: descriptor.identity, descriptor }],
      }),
      clearPersonalBrowserHumanInput: async () => { clears += 1; },
      highlightPersonalBrowserHumanInput: async (_contents, targets) => { highlights.push(targets); return highlight(); },
      scrollPersonalBrowserPage: options.scroll ?? (async () => ({ x: 0, y: 0 })),
    },
    "./personalBrowserHumanInput": humanInput,
    "./personalBrowserInputShield": { PersonalBrowserInputShield: class { sync(locked) { shieldStates.push(locked); } } },
    "./personalBrowserControlServer": { ...control, PersonalBrowserControlServer: ControlServer },
  };
  const hostSetTimeout = options.fakeTimers ? (callback, delay) => {
    const timer = { callback, delay, canceled: false, unref() {} };
    timers.push(timer);
    return timer;
  } : setTimeout;
  const hostClearTimeout = options.fakeTimers ? (timer) => { timer.canceled = true; } : clearTimeout;
  vm.runInNewContext(hostCode, { module, exports: module.exports, URL, setTimeout: hostSetTimeout, clearTimeout: hostClearTimeout,
    require: (specifier) => dependencies[specifier] ?? require(specifier) });
  const host = new module.exports.PersonalBrowserHost({ enabled: true, onReleaseExpiry() {}, onEmergencyPause(projectId) {
    pauses.push({ projectId, paused: !host.getStatus().agentControlEnabled, credentials: host.getControlCredentials(projectId) });
  } });
  host.ownerWindow = { isDestroyed: () => false, isVisible: () => true, webContents: { focus() {} }, getContentBounds: () => ({ width: 800, height: 600 }) };
  host.view = { setVisible() {}, webContents: { isDestroyed: () => false, getURL: () => "https://example.test/", getTitle: () => "Disposable fixture", isLoading: () => false, stop() {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false } } };
  host.currentState = "ready";
  host.currentProjectId = "project-fixture";
  host.currentPartition = security.derivePersonalBrowserPartition("fixture-profile");
  host.currentOwnerId = "owner-fixture";
  host.enablePreparedAgentControl(await host.prepareAgentControl());
  await host.handleControlOperation("snapshot", {});
  return { host, highlights, pauses, shieldStates, timers, getClears: () => clears };
}

test("Personal host handoff revokes credentials before requesting runtime stop and clears guidance on Resume", async () => {
  const { host, highlights, pauses, getClears } = await fixture();
  const result = await host.handleControlOperation("request_human_input", { indices: [0] });
  assert.equal(result.humanInputRequired, true);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0][0].expectation.identity, "fixture-document:1");
  assert.deepEqual(pauses, [{ projectId: "project-fixture", paused: true, credentials: null }]);
  const status = host.getStatus();
  assert.equal(status.agentControlEnabled, false);
  assert.equal(status.humanControlReady, true);
  assert.equal(status.humanInputRequest.origin, "https://example.test");
  assert.equal(status.humanInputRequest.fields[0].label, "Highlighted field 1");
  assert.equal(JSON.stringify(status.humanInputRequest).includes("Verification code"), false);
  assert.equal(status.humanInputRequest.expiresAtMs - status.humanInputRequest.createdAtMs, 600_000);
  await assert.rejects(host.handleControlOperation("snapshot", {}), /paused/);
  const previousClears = getClears();
  host.enablePreparedAgentControl(await host.prepareAgentControl());
  assert.equal(getClears(), previousClears + 1);
  assert.equal(host.getStatus().humanInputRequest, undefined);
  await assert.rejects(host.handleControlOperation("request_human_input", { indices: [0] }), /fresh Personal Browser snapshot/);
});

test("Personal host never publishes guidance after concurrent revocation during field resolution", async () => {
  let finish;
  const { host, pauses } = await fixture(() => new Promise((resolve) => { finish = resolve; }));
  const pending = host.handleControlOperation("request_human_input", { indices: [0] });
  await waitForStart(() => Boolean(finish));
  host.pauseAgentControl();
  finish(true);
  await assert.rejects(pending, /control was rotated/);
  assert.equal(host.getStatus().humanInputRequest, undefined);
  assert.equal(host.getControlCredentials("project-fixture"), null);
  assert.equal(pauses.length, 0);
});

test("Personal Pause keeps native input locked through drain timeout until in-flight work actually settles", async () => {
  let finish;
  const { host, shieldStates, timers } = await fixture(() => new Promise((resolve) => { finish = resolve; }), { fakeTimers: true });
  const pending = host.handleControlOperation("request_human_input", { indices: [0] });
  await waitForStart(() => Boolean(finish));
  host.pauseAgentControl();
  assert.equal(host.getStatus().agentControlEnabled, false, "future capability is revoked immediately");
  assert.equal(host.getStatus().humanControlReady, false, "revocation alone must not unlock the native page");
  assert.equal(shieldStates.at(-1), true);
  await assert.rejects(host.prepareAgentControl(), /still stopping/);
  await assert.rejects(host.navigate("https://example.test/next"), /active operations to stop/);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 15_000);
  timers[0].callback();
  assert.equal(host.getStatus().humanControlReady, false);
  assert.match(host.getStatus().error, /Input remains locked/);
  assert.equal(shieldStates.at(-1), true);
  finish(true);
  await assert.rejects(pending, /control was rotated/);
  assert.equal(host.getStatus().humanControlReady, true);
  assert.equal(shieldStates.at(-1), false);
  assert.equal(host.getStatus().error, undefined);
  assert.equal(timers[0].canceled, true);
});

test("Personal handoff returns its acknowledgement without waiting on itself but shields other in-flight operations", async () => {
  let finishScroll;
  const { host, shieldStates } = await fixture(async () => true, { scroll: () => new Promise((resolve) => { finishScroll = resolve; }) });
  const scrolling = host.handleControlOperation("scroll", { y: 100 });
  await waitForStart(() => Boolean(finishScroll));
  await host.handleControlOperation("snapshot", {});
  const handoff = await host.handleControlOperation("request_human_input", { indices: [0] });
  assert.equal(handoff.humanInputRequired, true);
  assert.equal(host.getStatus().humanControlReady, false);
  assert.equal(shieldStates.at(-1), true);
  finishScroll({ x: 0, y: 100 });
  await assert.rejects(scrolling, /control was rotated/);
  assert.equal(host.getStatus().humanControlReady, true);
  assert.equal(shieldStates.at(-1), false);
});

test("Personal host rejects changed fields without publishing a handoff or replaying the snapshot", async () => {
  const { host, pauses, highlights } = await fixture(async () => false);
  await assert.rejects(host.handleControlOperation("request_human_input", { indices: [0] }), /fields changed/);
  assert.equal(host.getStatus().humanInputRequest, undefined);
  assert.equal(host.getStatus().agentControlEnabled, true);
  assert.equal(pauses.length, 0);
  await assert.rejects(host.handleControlOperation("request_human_input", { indices: [0] }), /fresh Personal Browser snapshot/);
  assert.equal(highlights.length, 1);
});

test("Personal release and same-profile reclaim preserve the page but never inherit handoff guidance", async () => {
  const { host, getClears } = await fixture();
  await host.handleControlOperation("request_human_input", { indices: [0] });
  const view = host.view;
  const partition = host.currentPartition;
  const priorRequest = host.getStatus().humanInputRequest;
  assert.ok(priorRequest);
  const previousClears = getClears();
  const released = host.release("owner-fixture");
  assert.equal(released.humanInputRequest, undefined);
  assert.equal(getClears(), previousClears + 1);
  assert.equal(host.view, view);
  assert.equal(host.currentPartition, partition);
  // Reclaim independently rejects leftover guidance even from an older host's
  // release state; it cannot bind a prior request to a new renderer owner.
  host.humanInputRequest = priorRequest;
  const reclaimed = await host.open({ projectId: "project-fixture", profileKey: "fixture-profile", ownerId: "replacement-owner" });
  assert.equal(reclaimed.ownerId, "replacement-owner");
  assert.equal(reclaimed.humanInputRequest, undefined);
  assert.equal(reclaimed.agentControlEnabled, false);
  assert.equal(reclaimed.url, "https://example.test/");
  assert.equal(host.view, view);
  assert.equal(host.currentPartition, partition);
  assert.equal(getClears(), previousClears + 2);
  host.humanInputRequest = { ...priorRequest, handoffId: "new-owner-request" };
  host.release("owner-fixture");
  assert.equal(host.getStatus().humanInputRequest.handoffId, "new-owner-request", "a stale release cannot clear a newer owner's guidance");
});
