import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Agent tabs in the Personal Browser: the agent opens at most three visible
// tabs of its own while the person has resumed control. Every tool acts on
// the tab on screen, site approvals bind to the tab they were given in, and
// Pause or Escape ends the agent's control of every tab.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));
const pageBridge = require(path.join(packageRoot, "dist/personalBrowserPageBridge.js"));
const control = require(path.join(packageRoot, "dist/personalBrowserControlServer.js"));
const hostCode = ts.transpileModule(
  fs.readFileSync(path.join(packageRoot, "src/personalBrowserHost.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const NO_SECRET_SIGNALS = { credentialContext: false, secretField: false, secretCode: false, maskedNearReveal: false };

// Host names resolve here, never through the network.
const DNS = {
  "example.test": ["93.184.216.34"],
  "docs.example.test": ["93.184.216.35"],
  "news.example.test": ["93.184.216.36"],
  "shop.example.test": ["93.184.216.37"],
  "web.archive.org": ["93.184.216.38"],
  "rebind.example.test": ["10.0.0.5"],
  // Public when Desktop checks it, private when Chromium connects (DNS rebinding).
  "rebound.example.test": ["93.184.216.40"],
};
// Where Chromium's own connection lands, when that differs from the answer above.
const CONNECTED = { "rebound.example.test": "10.0.0.5" };
const lookups = [];
async function lookup(host) {
  lookups.push(host);
  const addresses = DNS[host];
  if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family: 4 }));
}

let nextContentsId = 1;

// One browser profile: every tab shares its session and request filter.
function fakeSession() {
  const session = {
    proxy: "DIRECT",
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, on() {},
    webRequest: {
      onBeforeRequest: (filter, listener) => { session.beforeRequestFilter = filter; session.beforeRequest = listener; },
      onHeadersReceived: (filter, listener) => { session.headersReceivedFilter = filter; session.headersReceived = listener; },
    },
    resolveProxy: async () => session.proxy,
  };
  return session;
}

class FakeContents {
  constructor(views, session) {
    this.views = views;
    this.id = nextContentsId++;
    this.url = "";
    this.title = "";
    this.handlers = {};
    this.destroyed = false;
    this.loads = [];
    // The address of the one link on the page, when a test gives it one.
    this.linkHref = null;
    this.session = session;
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, clear() {} };
  }
  on(name, handler) { (this.handlers[name] ??= []).push(handler); return this; }
  emit(name, ...args) { for (const handler of this.handlers[name] ?? []) handler(...args); }
  setWindowOpenHandler() {}
  // A page load as Chromium makes it: the session's request filter first,
  // then the response, which reports the address the connection reached.
  async loadURL(url) {
    this.loads.push(url);
    if (url !== "about:blank" && this.session.beforeRequest) {
      const request = { webContentsId: this.id, resourceType: "mainFrame", url };
      const before = await new Promise((resolve) => this.session.beforeRequest(request, resolve));
      if (before.cancel) this.blocked(url);
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      const ip = CONNECTED[host] ?? DNS[host]?.[0] ?? host;
      const response = this.session.headersReceived
        ? await new Promise((resolve) => this.session.headersReceived({ ...request, ip }, resolve))
        : {};
      if (response.cancel) this.blocked(url);
    }
    this.url = url;
    this.title = url === "about:blank" ? "" : `Page at ${new URL(url).host}`;
    this.emit("did-navigate", {}, url);
    this.emit("did-finish-load");
  }
  blocked(url) {
    this.url = url;
    this.title = "";
    this.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", url, true);
    throw Object.assign(new Error(`ERR_BLOCKED_BY_CLIENT (-20) loading '${url}'`), { code: "ERR_BLOCKED_BY_CLIENT", errno: -20 });
  }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isDestroyed() { return this.destroyed; }
  isLoading() { return false; }
  stop() {}
  focus() {}
  close() { this.destroyed = true; }
}

const linkOnlyModule = require(path.join(packageRoot, "dist/personalBrowserLinkOnly.js"));

function fixture({ choose = async () => ({ response: 1 }), linkOnlyData } = {}) {
  const dialogs = [];
  const views = [];
  const shield = { attached: [], syncs: [] };
  const session = fakeSession();
  lookups.length = 0;
  class ControlServer {
    credentials = null;
    getCredentials() { return this.credentials; }
    async bindProject(projectId) { this.credentials = { projectId }; }
    clearBinding() { this.credentials = null; }
  }
  class InputShield {
    attach(_owner, contents) { shield.attached.push(contents); }
    sync(active) { shield.syncs.push(active); }
    destroy() {}
  }
  class WebContentsView {
    constructor() {
      this.webContents = new FakeContents(views, session);
      this.visible = true;
      this.bounds = null;
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  const documentOf = (contents) => `document-${views.findIndex((view) => view.webContents === contents)}`;
  // The one link on each page: "More", or the address a test gave it.
  // The one target on each page: the link "More", the address a test gave
  // it, or the whole target a test describes (a form's field or button).
  const linkOf = (contents) => contents.targetDescriptor
    ? { found: true, disabled: false, identity: `${documentOf(contents)}:0`, ...contents.targetDescriptor }
    : {
      found: true, disabled: false, tag: "a", identity: `${documentOf(contents)}:0`, text: "More",
      ...(contents.linkHref ? { href: contents.linkHref, linkSelf: true } : {}),
    };
  const module = { exports: {} };
  const dependencies = {
    electron: {
      WebContentsView,
      dialog: { showMessageBox: async (_owner, options) => {
        dialogs.push(options);
        return choose(options);
      } },
    },
    "./browserTabCapture": require(path.join(packageRoot, "dist/browserTabCapture.js")),
    "./browserTabInput": require(path.join(packageRoot, "dist/browserTabInput.js")),
    "./browserTabExplorePage": { createBrowserTabExplorePage() { throw new Error("Unexpected native Explore page"); } },
    "./personalBrowserSecurity": {
      ...security,
      checkPersonalBrowserAgentTabUrl: (url) => security.checkPersonalBrowserAgentTabUrl(url, lookup),
    },
    // The bundled list, or the copy a test gives instead.
    "./personalBrowserLinkOnly": linkOnlyData === undefined
      ? linkOnlyModule
      : { ...linkOnlyModule, PERSONAL_BROWSER_LINK_ONLY_GUARD: linkOnlyModule.createPersonalBrowserLinkOnlyGuard(linkOnlyData) },
    "./personalBrowserRequestGuard": require(path.join(packageRoot, "dist/personalBrowserRequestGuard.js")),
    "./personalBrowserRedaction": require(path.join(packageRoot, "dist/personalBrowserRedaction.js")),
    "./personalBrowserActionPolicy": require(path.join(packageRoot, "dist/personalBrowserActionPolicy.js")),
    "./personalBrowserTeammateActivity": require(path.join(packageRoot, "dist/personalBrowserTeammateActivity.js")),
    "./personalBrowserPageBridge": {
      ...pageBridge,
      clearPersonalBrowserHumanInput: async () => {},
      snapshotPersonalBrowserPage: async (contents) => ({
        url: contents.getURL(),
        title: contents.getTitle(),
        text: `Text of ${contents.getURL()}`,
        documentToken: documentOf(contents),
        signals: NO_SECRET_SIGNALS,
        interactive: [{ index: 0, tag: "a", name: "More", identity: `${documentOf(contents)}:0`, descriptor: linkOf(contents) }],
        capturedAt: "2026-10-26T09:30:00.000Z",
      }),
      inspectPersonalBrowserTarget: async (contents) => linkOf(contents),
      clickPersonalBrowserTarget: async (contents) => {
        contents.clicks = (contents.clicks ?? 0) + 1;
        return { clicked: true, targetChanged: false };
      },
      typeIntoPersonalBrowserTarget: async (contents) => {
        contents.typed = (contents.typed ?? 0) + 1;
        return { typed: true, targetChanged: false, blockedSensitive: false, descriptor: linkOf(contents) };
      },
      pressPersonalBrowserTarget: async (contents) => {
        contents.presses = (contents.presses ?? 0) + 1;
        return { pressed: true, targetChanged: false };
      },
    },
    "./personalBrowserHumanInput": {},
    "./personalBrowserInputShield": { PersonalBrowserInputShield: InputShield },
    "./personalBrowserControlServer": { ...control, PersonalBrowserControlServer: ControlServer },
  };
  vm.runInNewContext(hostCode, {
    module, exports: module.exports, URL, setTimeout, clearTimeout,
    require: (specifier) => dependencies[specifier] ?? require(specifier),
  });
  const host = new module.exports.PersonalBrowserHost({ enabled: true, onReleaseExpiry() {} });
  host.ownerWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ width: 800, height: 600 }),
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: { focus() {} },
  };
  // The person's own tab, already on a page, built as Desktop builds it: its
  // view configures the profile's session and its navigation guards.
  host.createView("partition-fixture");
  const personView = views[0];
  personView.webContents.url = "https://example.test/";
  personView.webContents.title = "Person's page";
  host.currentState = "ready";
  host.currentVisible = true;
  host.currentProjectId = "project-fixture";
  host.currentPartition = "partition-fixture";
  host.currentOwnerId = "owner-fixture";
  return { host, dialogs, views, shield, personView, session };
}

// Values made in the host's own context compare as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function resume(host, mode = "ask") {
  host.enablePreparedAgentControl(await host.prepareAgentControl(mode));
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("the agent opens a visible tab only after Resume, and it is shown and badged as the agent's", async () => {
  const { host, views, personView } = fixture();
  await rejectsWith(host.handleControlOperation("open_tab", { url: "https://docs.example.test/" }), "agent_control_paused");
  assert.equal(views.length, 1, "no tab is created while control is paused");

  await resume(host, "routine");
  const opened = await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  assert.equal(opened.tab.openedBy, "agent");
  assert.equal(opened.tab.active, true);
  assert.equal(opened.tab.url, "https://docs.example.test/");
  assert.equal(views.length, 2);
  assert.deepEqual(views[1].webContents.loads, ["https://docs.example.test/"]);
  // The new tab is the one on screen; the person's tab is hidden behind it.
  assert.equal(views[1].visible, true);
  assert.equal(personView.visible, false);

  const status = host.getStatus();
  assert.equal(status.activeTabId, opened.tab.tabId);
  assert.deepEqual(plain(status.tabs.map((tab) => [tab.openedBy, tab.active])), [["person", false], ["agent", true]]);
  assert.equal(status.maxAgentTabs, 3);
});

test("a site allowed in one tab is not allowed in another: each tab asks for its own site in Ask mode", async () => {
  const { host, dialogs } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("snapshot", {});
  assert.equal(dialogs.length, 1, "the person's tab asks for its site");
  assert.match(dialogs[0].detail, /in this tab/);

  const opened = await host.handleControlOperation("open_tab", { url: "https://example.test/other" });
  assert.equal(dialogs.length, 2, "the same site asks again in the agent's new tab");
  assert.match(dialogs[1].message, /example\.test/);

  // Back in the person's tab, its own approval still holds and nothing asks.
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  await host.handleControlOperation("snapshot", {});
  assert.equal(dialogs.length, 2);
  await host.handleControlOperation("select_tab", { tabId: opened.tab.tabId });
  await host.handleControlOperation("snapshot", {});
  assert.equal(dialogs.length, 2);
});

test("a site the person denies closes the new tab and shows the previous one again", async () => {
  const { host, views, personView } = fixture({ choose: async (options) => ({ response: /docs/.test(options.message) ? 0 : 1 }) });
  await resume(host, "ask");
  await rejectsWith(host.handleControlOperation("open_tab", { url: "https://docs.example.test/" }), "origin_not_approved");
  assert.equal(views[1].webContents.destroyed, true);
  assert.deepEqual(views[1].webContents.loads, []);
  assert.equal(host.getStatus().tabs.length, 1);
  assert.equal(host.getStatus().activeTabId, "tab-1");
  assert.equal(personView.visible, true);
});

test("at most three agent tabs are open at once", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  for (const site of ["docs", "news", "shop"]) {
    await host.handleControlOperation("open_tab", { url: `https://${site}.example.test/` });
  }
  await rejectsWith(host.handleControlOperation("open_tab", { url: "https://example.test/fourth" }), "agent_tab_limit");
  assert.equal(views.length, 4, "the fourth tab is never created");
  const closed = await host.handleControlOperation("close_tab", { tabId: "tab-3" });
  assert.equal(closed.closed, "tab-3");
  await host.handleControlOperation("open_tab", { url: "https://example.test/fourth" });
  assert.equal(host.getStatus().tabs.filter((tab) => tab.openedBy === "agent").length, 3);
});

for (const [name, url] of [
  ["a loopback address", "http://127.0.0.1:8080/"],
  ["a private network address", "http://192.168.1.1/"],
  ["an IPv6 loopback", "http://[::1]/"],
  ["a local host name", "http://router.local/"],
  ["a single-label name", "http://intranet/"],
  ["a name that resolves to a private address", "https://rebind.example.test/"],
]) {
  test(`an agent tab never opens ${name}`, async () => {
    const { host, views, dialogs } = fixture();
    await resume(host, "routine");
    await rejectsWith(host.handleControlOperation("open_tab", { url }), "private_address_blocked");
    assert.equal(views.length, 1);
    assert.equal(dialogs.length, 1, "only the routine start dialog was shown");
  });
}

test("navigate in an agent tab keeps to public addresses", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await rejectsWith(host.handleControlOperation("navigate", { url: "http://10.1.2.3/admin" }), "private_address_blocked");
  assert.deepEqual(views[1].webContents.loads, ["https://docs.example.test/"]);

  // A redirect or a navigation the page starts in an agent tab is held to the same rule.
  let prevented = false;
  views[1].webContents.emit("will-redirect", { preventDefault() { prevented = true; } }, "http://192.168.0.1/");
  assert.equal(prevented, true);
});

// What the session's request filter decides for one request.
function beforeRequest(contents, details) {
  return new Promise((resolve) => contents.session.beforeRequest({ webContentsId: contents.id, ...details }, resolve));
}

test("every page request of an agent tab, each redirect hop included, resolves its host and stays public", async () => {
  const { host, views, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  const agentContents = views[1].webContents;
  // Every request goes through the filter, WebSocket handshakes included.
  assert.equal(agentContents.session.beforeRequestFilter.types, undefined);
  // A link the agent clicks, or a redirect, to a public name that resolves to the local network.
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://rebind.example.test/admin" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "subFrame", url: "https://rebind.example.test/" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://unknown.example.test/" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://news.example.test/" })), { cancel: false });
  // A page's own request to a name is not resolved first: its response is checked when it arrives.
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "image", url: "https://rebind.example.test/a.png" })), {});
  // The person's tab was on screen when the agent took control, so the agent drives it too.
  assert.deepEqual(
    plain(await beforeRequest(agentContents, { webContentsId: personView.webContents.id, resourceType: "mainFrame", url: "https://rebind.example.test/" })),
    { cancel: true },
  );
  // Once the person has paused, the tab is theirs.
  host.pauseAgentControl();
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://rebind.example.test/" })), {});
});

test("a local host name written with a final dot is still local in an agent tab", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  for (const url of ["http://localhost.:3000/", "http://router.lan./", "http://intranet./"]) {
    let prevented = false;
    views[1].webContents.emit("will-redirect", { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true, url);
  }
});

test("Pause ends the agent's control of every tab and every tab's approvals", async () => {
  const { host, dialogs } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await host.handleControlOperation("snapshot", {});
  const asked = dialogs.length;

  host.pauseAgentControl();
  assert.equal(host.getStatus().agentControlEnabled, false);
  assert.equal(host.getControlCredentials("project-fixture"), null);
  for (const [operation, payload] of [
    ["list_tabs", {}], ["select_tab", { tabId: "tab-1" }], ["close_tab", { tabId: "tab-2" }],
    ["open_tab", { url: "https://news.example.test/" }], ["snapshot", {}],
  ]) {
    await rejectsWith(host.handleControlOperation(operation, payload), "agent_control_paused");
  }
  // The agent's tab stays open and visible for the person to take over.
  assert.equal(host.getStatus().tabs.length, 2);

  // A later Resume starts again: both tabs ask for their sites anew.
  await resume(host, "ask");
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  await host.handleControlOperation("snapshot", {});
  assert.equal(dialogs.length, asked + 2);
});

test("Escape ends the agent's control of every tab", async () => {
  const { host } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await host.handleControlOperation("open_tab", { url: "https://news.example.test/" });
  host.emergencyPauseAgentControl();
  assert.equal(host.getStatus().agentControlEnabled, false);
  await rejectsWith(host.handleControlOperation("select_tab", { tabId: "tab-2" }), "agent_control_paused");
  await rejectsWith(host.handleControlOperation("snapshot", {}), "agent_control_paused");
});

test("switching tabs ends every snapshot, so a step never lands on a page the agent has not observed", async () => {
  const { host } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  await rejectsWith(host.handleControlOperation("click", { index: 0 }), "fresh_snapshot_required");
});

test("the agent closes only its own tabs; the person's tab stays", async () => {
  const { host, views, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await rejectsWith(host.handleControlOperation("close_tab", { tabId: "tab-1" }), "tab_not_agent_owned");
  await rejectsWith(host.handleControlOperation("select_tab", { tabId: "tab-9" }), "tab_not_found");
  await rejectsWith(host.handleControlOperation("select_tab", { tabId: "../tab-1" }), "invalid_tab_id");
  await host.handleControlOperation("close_tab", { tabId: "tab-2" });
  assert.equal(views[1].webContents.destroyed, true);
  assert.equal(host.getStatus().activeTabId, "tab-1");
  assert.equal(personView.visible, true);
});

test("list_tabs shows a tab's address only when its site is allowed in that tab", async () => {
  const { host } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/guide" });
  const { tabs } = await host.handleControlOperation("list_tabs", {});
  assert.deepEqual(plain(tabs.map((tab) => [tab.tabId, tab.openedBy, tab.active, tab.url])), [
    ["tab-1", "person", false, ""],
    ["tab-2", "agent", true, "https://docs.example.test/guide"],
  ]);
  assert.equal(tabs[0].title, undefined, "the person's tab title stays hidden until its site is allowed");
  const status = await host.handleControlOperation("status", {});
  assert.deepEqual(plain(status.status.tabs.map((tab) => tab.url)), ["", "https://docs.example.test/guide"]);
});

test("a tab not on screen never asks, and a navigation its page starts that would ask is stopped", async () => {
  const { host, views, dialogs } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  const asked = dialogs.length;
  const background = views[1].webContents;
  let crossSite = false;
  background.emit("will-navigate", { preventDefault() { crossSite = true; } }, "https://shop.example.test/");
  let sameSite = false;
  background.emit("will-navigate", { preventDefault() { sameSite = true; } }, "https://docs.example.test/next");
  let risky = false;
  background.emit("will-navigate", { preventDefault() { risky = true; } }, "https://docs.example.test/account/logout");
  assert.deepEqual([crossSite, sameSite, risky], [true, false, true]);
  assert.equal(dialogs.length, asked);
});

test("the person shows and closes tabs only while the agent is paused", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  assert.throws(() => host.selectTab("owner-fixture", "tab-1"), /Pause/);
  assert.throws(() => host.closeTab("owner-fixture", "tab-2"), /Pause/);
  host.pauseAgentControl();
  assert.equal(host.selectTab("someone-else", "tab-1").activeTabId, "tab-2", "another owner changes nothing");
  assert.equal(host.selectTab("owner-fixture", "tab-1").activeTabId, "tab-1");
  assert.throws(() => host.closeTab("owner-fixture", "tab-1"), /agent opened/);
  assert.equal(host.closeTab("owner-fixture", "tab-2").tabs.length, 1);
  assert.equal(views[1].webContents.destroyed, true);
});

test("sharing is scoped to the page on screen: an agent tab does not open into a share, and switching ends one", async () => {
  const { host } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  host.pauseAgentControl();
  host.startTabShare("owner-fixture");
  assert.equal(host.getStatus().sharing, true);
  host.selectTab("owner-fixture", "tab-1");
  assert.equal(host.getStatus().sharing, false);

  host.startTabShare("owner-fixture");
  await resume(host, "routine");
  await rejectsWith(host.handleControlOperation("open_tab", { url: "https://news.example.test/" }), "tab_share_active");
  await rejectsWith(host.handleControlOperation("select_tab", { tabId: "tab-2" }), "tab_share_active");
});

test("clearing browser data closes every agent tab", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  host.view.webContents.session = { ...host.view.webContents.session, clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {}, flushStorageData() {} };
  views[0].webContents.session = host.view.webContents.session;
  await host.clearData();
  assert.equal(views[1].webContents.destroyed, true);
  assert.deepEqual(plain(host.getStatus().tabs.map((tab) => tab.openedBy)), ["person"]);
});

test("closing the browser closes every tab and starts over with one person's tab", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await host.close();
  assert.ok(views.every((view) => view.webContents.destroyed));
  assert.deepEqual(plain(host.getStatus().tabs.map((tab) => [tab.id, tab.openedBy])), [["tab-1", "person"]]);
});

// Hardening: the rules hold for every step the agent drives, in every tab.

// What the session decides when a response arrives from `ip`.
function headersReceived(contents, details) {
  return new Promise((resolve) => contents.session.headersReceived({ webContentsId: contents.id, ...details }, resolve));
}

const PAGE_STEPS = [
  ["snapshot", {}], ["click", { index: 0 }], ["type", { index: 0, text: "hello" }],
  ["press", { index: 0, key: "Enter" }], ["scroll", { y: 200 }], ["request_human_input", { indices: [0] }],
];

test("open_tab refuses a link-only site before any prompt or lookup, and opens no tab", async () => {
  const { host, views, dialogs } = fixture();
  await resume(host, "ask");
  for (const url of ["https://www.booking.com/hotel/x.html", "https://www.airbnb.co.uk/rooms/1", "https://maps.google.com/?q=cafe", "https://a.co/d/123"]) {
    await assert.rejects(host.handleControlOperation("open_tab", { url }), (error) => {
      assert.equal(error.code, "link_only_site", url);
      assert.match(error.message, /link-only/);
      assert.match(error.message, /Send page to Octo/);
      return true;
    });
  }
  assert.equal(views.length, 1, "no tab was created");
  assert.equal(dialogs.length, 0, "nothing asked");
  assert.deepEqual(lookups, [], "no name was resolved");
});

test("navigate refuses a link-only site in every tab, the person's included, before any prompt", async () => {
  const { host, views, dialogs, personView } = fixture();
  await resume(host, "ask");
  await rejectsWith(host.handleControlOperation("navigate", { url: "https://www.booking.com/" }), "link_only_site");
  assert.deepEqual(personView.webContents.loads, []);
  assert.equal(dialogs.length, 0);
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  const asked = dialogs.length;
  await rejectsWith(host.handleControlOperation("navigate", { url: "https://www.tripadvisor.com/Hotel" }), "link_only_site");
  assert.deepEqual(views[1].webContents.loads, ["https://docs.example.test/"]);
  assert.equal(dialogs.length, asked);
});

test("a page on a link-only site is never read or used, in any tab, and nothing asks about it", async () => {
  const { host, dialogs, personView } = fixture();
  // The person left their own tab on a link-only site, then resumed.
  personView.webContents.url = "https://www.booking.com/hotel/x.html";
  personView.webContents.title = "Hotel X, prices and reviews";
  await resume(host, "ask");
  for (const [operation, payload] of PAGE_STEPS) {
    await assert.rejects(host.handleControlOperation(operation, payload), (error) => {
      assert.equal(error.code, "link_only_site", operation);
      assert.match(error.message, /Booking\.com is link-only/);
      return true;
    });
  }
  assert.equal(dialogs.length, 0, "no site prompt for a link-only page");
  // Status and list_tabs give its site's name, never its address or title.
  const { status } = await host.handleControlOperation("status", {});
  assert.equal(status.url, "");
  assert.equal(status.title, undefined);
  assert.equal(status.linkOnlySite, "Booking.com");
  const { tabs } = await host.handleControlOperation("list_tabs", {});
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, "");
  assert.equal(tabs[0].title, undefined);
  assert.equal(tabs[0].linkOnlySite, "Booking.com");
  // The agent may still take the tab somewhere else.
  await host.handleControlOperation("navigate", { url: "https://example.test/" });
  assert.deepEqual(personView.webContents.loads, ["https://example.test/"]);
});

test("a link the agent clicks or presses Enter on to a link-only site or a private address is refused before any prompt", async () => {
  const { host, dialogs, personView } = fixture();
  await resume(host, "ask");
  for (const [href, code] of [
    ["https://www.booking.com/deal", "link_only_site"],
    ["http://192.168.1.1/admin", "private_address_blocked"],
    ["https://rebind.example.test/", "private_address_blocked"],
  ]) {
    personView.webContents.linkHref = href;
    for (const [operation, payload] of [["click", { index: 0 }], ["press", { index: 0, key: "Enter" }]]) {
      await host.handleControlOperation("snapshot", {});
      const asked = dialogs.length;
      await rejectsWith(host.handleControlOperation(operation, payload), code);
      assert.equal(dialogs.length, asked, `${operation} on ${href} asked nothing`);
    }
    assert.equal(personView.webContents.clicks ?? 0, 0, `${href} was not clicked`);
  }
  // A link to a place on the same page loads nothing and stays allowed.
  personView.webContents.linkHref = "https://example.test/#reviews";
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 0 });
  assert.equal(personView.webContents.clicks, 1);
});

test("in every tab the agent drives, each page, frame and redirect hop to a link-only site is stopped, and the next step says why", async () => {
  const { host, views, dialogs, personView } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("snapshot", {});
  // The person's tab, on screen when the agent took control.
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "https://www.booking.com/" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "subFrame", url: "https://www.google.com/maps/embed" })), { cancel: true });
  const asked = dialogs.length;
  await assert.rejects(host.handleControlOperation("snapshot", {}), (error) => {
    assert.equal(error.code, "link_only_site");
    assert.match(error.message, /stopped the page before it loaded/);
    return true;
  });
  // Reported once; the page itself did not change.
  await host.handleControlOperation("snapshot", {});
  // A redirect or a page-started navigation in an agent tab is refused without asking.
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  let prevented = false;
  views[1].webContents.emit("will-redirect", { preventDefault() { prevented = true; } }, "https://www.amazon.de/dp/1");
  assert.equal(prevented, true);
  let started = false;
  views[1].webContents.emit("will-navigate", { preventDefault() { started = true; } }, "https://www.expedia.com/");
  assert.equal(started, true);
  assert.equal(dialogs.length, asked + 1, "only the new tab's own site asked");
  await rejectsWith(host.handleControlOperation("snapshot", {}), "link_only_site");
});

test("a translator's, cache's or archive's copy of a link-only site is refused like the site, on every route, before any prompt or lookup", async () => {
  const { host, views, dialogs, personView } = fixture();
  await resume(host, "ask");
  await assert.rejects(host.handleControlOperation("open_tab", { url: "https://www-booking-com.translate.goog/hotel?_x_tr_sl=auto" }), (error) => {
    assert.equal(error.code, "link_only_site");
    assert.match(error.message, /^Booking\.com is link-only/);
    assert.match(error.message, /its copy on Google Translate's page proxy/);
    return true;
  });
  await rejectsWith(host.handleControlOperation("navigate", { url: "https://web.archive.org/web/2024/https://www.amazon.de/dp/1" }), "link_only_site");
  assert.equal(views.length, 1, "no tab was created");
  assert.deepEqual(personView.webContents.loads, []);
  assert.equal(dialogs.length, 0, "nothing asked");
  assert.deepEqual(lookups, [], "no name was resolved");
  // A link to one, and a page load or redirect hop that reaches one.
  personView.webContents.linkHref = "https://archive.ph/newest/https://www.airbnb.com/rooms/1";
  await host.handleControlOperation("snapshot", {});
  await rejectsWith(host.handleControlOperation("click", { index: 0 }), "link_only_site");
  assert.equal(personView.webContents.clicks ?? 0, 0);
  assert.deepEqual(
    plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "https://webcache.googleusercontent.com/search?q=cache:www.tripadvisor.com/x" })),
    { cancel: true },
  );
  // The wrapper's copy of another site is an ordinary page.
  await host.handleControlOperation("open_tab", { url: "https://web.archive.org/web/2024/https://docs.example.test/" });
  assert.deepEqual(views[1].webContents.loads, ["https://web.archive.org/web/2024/https://docs.example.test/"]);
});

test("the person's own browsing is unchanged: once paused, link-only sites and private addresses load as before", async () => {
  const { host, views, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  host.pauseAgentControl();
  for (const contents of [personView.webContents, views[1].webContents]) {
    assert.deepEqual(plain(await beforeRequest(contents, { resourceType: "mainFrame", url: "https://www.booking.com/" })), {});
    assert.deepEqual(plain(await beforeRequest(contents, { resourceType: "mainFrame", url: "http://192.168.1.1/" })), {});
    assert.deepEqual(plain(await headersReceived(contents, { resourceType: "mainFrame", url: "https://rebound.example.test/", ip: "10.0.0.5" })), {});
  }
  host.selectTab("owner-fixture", "tab-1");
  await host.navigate("https://www.booking.com/hotel/x.html");
  assert.deepEqual(personView.webContents.loads, ["https://www.booking.com/hotel/x.html"]);
  await host.navigate("http://192.168.1.1/");
  assert.deepEqual(personView.webContents.loads.at(-1), "http://192.168.1.1/");
});

test("without the link-only list, every agent-driven step fails closed; the person's browsing does not", async () => {
  for (const data of [null, { schema: "instafy.link-only-sites@2", sites: [] }, { schema: "instafy.link-only-sites@1", sites: [{ name: "Broken", match: ["not a host!"] }] }]) {
    const { host, views, dialogs, personView } = fixture({ linkOnlyData: data });
    await resume(host, "ask");
    await rejectsWith(host.handleControlOperation("open_tab", { url: "https://docs.example.test/" }), "link_only_list_unavailable");
    await rejectsWith(host.handleControlOperation("navigate", { url: "https://docs.example.test/" }), "link_only_list_unavailable");
    await rejectsWith(host.handleControlOperation("snapshot", {}), "link_only_list_unavailable");
    assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "https://docs.example.test/" })), { cancel: true });
    assert.equal(views.length, 1);
    assert.equal(dialogs.length, 0);
    host.pauseAgentControl();
    assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "https://docs.example.test/" })), {});
    await host.navigate("https://docs.example.test/");
    assert.deepEqual(personView.webContents.loads, ["https://docs.example.test/"]);
  }
});

test("navigate never takes the person's tab to a private address, a local name or a name that resolves to one", async () => {
  const { host, dialogs, personView } = fixture();
  await resume(host, "ask");
  for (const url of ["http://127.0.0.1:8080/", "http://[::1]/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://router.local/", "http://intranet/", "https://rebind.example.test/"]) {
    await rejectsWith(host.handleControlOperation("navigate", { url }), "private_address_blocked");
  }
  assert.deepEqual(personView.webContents.loads, []);
  assert.equal(dialogs.length, 0, "refused before any prompt");
});

test("select_tab back to the person's tab does not open it to private addresses", async () => {
  const { host, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  await rejectsWith(host.handleControlOperation("navigate", { url: "http://10.0.0.1/" }), "private_address_blocked");
  await rejectsWith(host.handleControlOperation("navigate", { url: "http://localhost:5173/" }), "private_address_blocked");
  assert.deepEqual(personView.webContents.loads, []);
  // A redirect or page-started navigation there is held to the same rule.
  let prevented = false;
  personView.webContents.emit("will-redirect", { preventDefault() { prevented = true; } }, "http://192.168.0.1/");
  assert.equal(prevented, true);
});

test("a tab of the person's that stays in the background while the agent works is not filtered", async () => {
  const { host, views, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  host.pauseAgentControl();
  // The person shows the agent's tab, then resumes: their own tab stays behind it.
  host.selectTab("owner-fixture", "tab-2");
  await resume(host, "routine");
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "http://192.168.1.1/" })), {});
  assert.deepEqual(plain(await beforeRequest(views[1].webContents, { resourceType: "mainFrame", url: "http://192.168.1.1/" })), { cancel: true });
  // Once the agent shows the person's tab, it drives it.
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "http://192.168.1.1/" })), { cancel: true });
});

test("a page or frame whose server answers from a private address is stopped when the response arrives (DNS rebinding)", async () => {
  const { host, views, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  const agentContents = views[1].webContents;
  for (const contents of [agentContents, personView.webContents]) {
    for (const ip of ["10.0.0.5", "127.0.0.1", "::1", "::ffff:192.168.0.1", "169.254.169.254", "fe80::1"]) {
      for (const resourceType of ["mainFrame", "subFrame"]) {
        assert.deepEqual(plain(await headersReceived(contents, { resourceType, url: "https://rebound.example.test/", ip })), { cancel: true }, `${ip} ${resourceType}`);
      }
    }
    assert.deepEqual(plain(await headersReceived(contents, { resourceType: "mainFrame", url: "https://news.example.test/", ip: "93.184.216.36" })), {});
    // A response from the HTTP cache made no connection: the check before the request stands.
    assert.deepEqual(plain(await headersReceived(contents, { resourceType: "mainFrame", url: "https://news.example.test/" })), {});
  }
  // The page's own requests too: a page already open that fetches the
  // rebinding name again gets nothing from the private address.
  for (const resourceType of ["xhr", "script", "image", "webSocket", "other"]) {
    assert.deepEqual(plain(await headersReceived(agentContents, { resourceType, url: "https://rebound.example.test/data", ip: "10.0.0.5" })), { cancel: true }, resourceType);
    assert.deepEqual(plain(await headersReceived(agentContents, { resourceType, url: "https://news.example.test/data", ip: "93.184.216.36" })), {}, resourceType);
  }
  // A request no tab makes is not a tab's, and once paused nothing is held back.
  assert.deepEqual(plain(await headersReceived(agentContents, { webContentsId: undefined, resourceType: "xhr", url: "https://rebound.example.test/", ip: "10.0.0.5" })), {});
  host.pauseAgentControl();
  assert.deepEqual(plain(await headersReceived(agentContents, { resourceType: "xhr", url: "https://rebound.example.test/data", ip: "10.0.0.5" })), {});
  assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType: "mainFrame", url: "https://rebound.example.test/", ip: "10.0.0.5" })), {});
});

test("navigate and open_tab report a page Desktop stopped because its server was at a private address", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  // The name passes the check before the request, then Chromium connects to 10.0.0.5.
  await assert.rejects(host.handleControlOperation("open_tab", { url: "https://rebound.example.test/" }), (error) => {
    assert.equal(error.code, "private_address_blocked");
    assert.match(error.message, /private or local address/);
    return true;
  });
  assert.equal(views[1].webContents.destroyed, true, "the stopped tab closes");
  assert.equal(host.getStatus().tabs.length, 1);
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  await rejectsWith(host.handleControlOperation("navigate", { url: "https://rebound.example.test/admin" }), "private_address_blocked");
  // Reported once: the next step goes ahead.
  await host.handleControlOperation("navigate", { url: "https://news.example.test/" });
});

test("through a proxy the connection reaches the proxy: its own address passes, any other private one does not", async () => {
  const { host, session, personView } = fixture();
  await resume(host, "routine");
  session.proxy = "PROXY 10.1.1.1:3128; DIRECT";
  assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType: "mainFrame", url: "https://news.example.test/", ip: "10.1.1.1" })), {});
  assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType: "mainFrame", url: "https://rebound.example.test/", ip: "10.0.0.5" })), { cancel: true });
  session.proxy = "DIRECT";
  assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType: "mainFrame", url: "https://news.example.test/", ip: "10.1.1.1" })), { cancel: true });
});

test("a stopped page or a failed frame leaves the browser ready; a page that fails to load still reports its error", async () => {
  const { host, personView } = fixture();
  await resume(host, "routine");
  // A link-only map embed Desktop stopped, or any other frame that failed.
  personView.webContents.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", "https://www.google.com/maps/embed", false);
  personView.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://ads.example.test/frame", false);
  // The page itself, stopped by Desktop's request filter.
  personView.webContents.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", "https://www.booking.com/", true);
  assert.equal(host.getStatus().state, "ready");
  await host.handleControlOperation("list_tabs", {});
  personView.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://gone.example.test/", true);
  assert.equal(host.getStatus().state, "error");
  assert.equal(host.getStatus().error, "ERR_NAME_NOT_RESOLVED");
});

test("a navigation the page starts to a name that resolves to a private address is stopped without asking", async () => {
  const { host, dialogs, personView } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("snapshot", {});
  const asked = dialogs.length;
  for (const url of ["https://rebind.example.test/", "https://rebind.example.test/account/logout"]) {
    let prevented = false;
    personView.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true, url);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dialogs.length, asked, `${url} asked nothing`);
    await rejectsWith(host.handleControlOperation("snapshot", {}), "private_address_blocked");
  }
  assert.deepEqual(personView.webContents.loads, []);
  // A public site the page opens still asks, as before.
  personView.webContents.emit("will-navigate", { preventDefault() {} }, "https://shop.example.test/");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dialogs.length, asked + 1);
  assert.match(dialogs.at(-1).message, /shop\.example\.test/);
});

test("a page the person opened keeps working while the agent reads it; a page the agent opens there is held to its rules", async () => {
  const { host, personView } = fixture();
  // The person's own page, a local app, on screen when they resume.
  personView.webContents.url = "http://localhost:5173/";
  await resume(host, "routine");
  await host.handleControlOperation("snapshot", {});
  // Its frames and its own requests (scripts, fetch, the dev server's socket) go on as before.
  for (const resourceType of ["subFrame", "xhr", "script", "webSocket"]) {
    assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType, url: "http://localhost:5173/api" })), {}, resourceType);
    assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType, url: "http://localhost:5173/api", ip: "127.0.0.1" })), {}, resourceType);
  }
  // A page load in that tab is the agent's, and holds to its rules.
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "mainFrame", url: "http://localhost:5173/next" })), { cancel: true });
  await rejectsWith(host.handleControlOperation("snapshot", {}), "private_address_blocked");
  // So does the page the agent opens there, frames and own requests included.
  await host.handleControlOperation("navigate", { url: "https://news.example.test/" });
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "subFrame", url: "https://www.google.com/maps/embed" })), { cancel: true });
  assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType: "xhr", url: "https://news.example.test/api", ip: "10.0.0.5" })), { cancel: true });
  // Once the person has paused and opened a page of their own, it is theirs again.
  host.pauseAgentControl();
  await host.navigate("http://localhost:5173/");
  await resume(host, "routine");
  assert.deepEqual(plain(await headersReceived(personView.webContents, { resourceType: "xhr", url: "http://localhost:5173/api", ip: "127.0.0.1" })), {});
});

// Review hardening: what the person browses stays theirs, a page the agent
// opened stays the agent's, and every request and form follows the rules.

// A navigation the page itself starts (a script or a link in it): the
// navigation guard first, then the same request filter a load goes through.
async function pageNavigates(contents, url) {
  let prevented = false;
  contents.emit("will-navigate", { preventDefault() { prevented = true; } }, url);
  if (prevented) return "prevented";
  try {
    await contents.loadURL(url);
    return "loaded";
  } catch {
    return "stopped";
  }
}

test("status and list_tabs never tell the agent which link-only site the person has open in a tab it does not drive", async () => {
  const { host, personView } = fixture();
  personView.webContents.url = "https://www.booking.com/hotel/x.html";
  personView.webContents.title = "Hotel X, prices and reviews";
  // Paused: the agent learns nothing about the person's page, as for any other site.
  const paused = (await host.handleControlOperation("status", {})).status;
  assert.equal(paused.url, "");
  assert.equal(paused.title, undefined);
  assert.equal(paused.linkOnlySite, undefined);
  assert.deepEqual(plain(paused.tabs.map((tab) => [tab.url, tab.linkOnlySite ?? null])), [["", null]]);

  // Resumed with the agent's own tab on screen: the person's tab behind it is not the agent's.
  personView.webContents.url = "https://example.test/";
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  host.pauseAgentControl();
  host.selectTab("owner-fixture", "tab-2");
  personView.webContents.url = "https://www.booking.com/hotel/x.html";
  await resume(host, "routine");
  const { tabs } = await host.handleControlOperation("list_tabs", {});
  assert.deepEqual(plain(tabs.map((tab) => [tab.tabId, tab.url, tab.linkOnlySite ?? null])), [
    ["tab-1", "", null],
    ["tab-2", "https://docs.example.test/", null],
  ]);
  const { status } = await host.handleControlOperation("status", {});
  assert.equal(status.tabs[0].linkOnlySite, undefined);
  // Once the agent shows that tab, it drives it, and is told only the site's name.
  await host.handleControlOperation("select_tab", { tabId: "tab-1" });
  const shown = (await host.handleControlOperation("status", {})).status;
  assert.equal(shown.url, "");
  assert.equal(shown.linkOnlySite, "Booking.com");
  assert.equal(shown.tabs[0].linkOnlySite, "Booking.com");
});

test("a page the agent opened reaches no private address with its own requests, a WebSocket included, before they leave the browser", async () => {
  const { host, views, session, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  const agentContents = views[1].webContents;
  // WebSocket handshakes go through the filter too: Chromium matches them by their own scheme.
  for (const pattern of ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"]) {
    assert.ok(session.beforeRequestFilter.urls.includes(pattern), pattern);
  }
  lookups.length = 0;
  for (const [resourceType, url] of [
    ["xhr", "http://127.0.0.1:8080/api/delete"],
    ["image", "http://192.168.1.1/logo.png"],
    ["script", "http://localhost:3000/app.js"],
    ["other", "http://[::1]:9000/"],
    ["webSocket", "ws://127.0.0.1:5173/"],
    ["webSocket", "ws://router.local/socket"],
    // A WebSocket reports no connected address, so its name is resolved before it connects.
    ["webSocket", "wss://rebind.example.test/socket"],
  ]) {
    assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType, url })), { cancel: true }, `${resourceType} ${url}`);
  }
  // Public ones go ahead; a page's own request to a name is not resolved first.
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "webSocket", url: "wss://news.example.test/socket" })), { cancel: false });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "xhr", url: "https://news.example.test/api" })), {});
  assert.deepEqual(lookups, ["rebind.example.test", "news.example.test"]);
  // A page the person opened is theirs: its local socket and requests go on.
  host.pauseAgentControl();
  personView.webContents.url = "http://localhost:5173/";
  host.selectTab("owner-fixture", "tab-1");
  await host.navigate("http://localhost:5173/");
  await resume(host, "routine");
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "webSocket", url: "ws://localhost:5173/" })), {});
  assert.deepEqual(plain(await beforeRequest(personView.webContents, { resourceType: "xhr", url: "http://localhost:5173/api" })), {});
});

test("a page the agent opened stays the agent's while the person has control: what it reaches on a private address then is never read", async () => {
  for (const reach of [
    // Its script fetches a rebinding name: the answer came from 10.0.0.5.
    (contents) => headersReceived(contents, { resourceType: "xhr", url: "https://rebound.example.test/data", ip: "10.0.0.5" }),
    (contents) => beforeRequest(contents, { resourceType: "xhr", url: "http://192.168.1.1/status" }),
    (contents) => beforeRequest(contents, { resourceType: "subFrame", url: "http://router.local/" }),
    (contents) => beforeRequest(contents, { resourceType: "webSocket", url: "ws://127.0.0.1:9229/" }),
    // A WebSocket's name is resolved: no connected address is reported for it.
    (contents) => beforeRequest(contents, { resourceType: "webSocket", url: "wss://rebind.example.test/socket" }),
  ]) {
    const { host, views, dialogs } = fixture();
    await resume(host, "routine");
    await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
    const agentContents = views[1].webContents;
    host.pauseAgentControl();
    // Paused, nothing is held back.
    assert.deepEqual(plain(await reach(agentContents)), {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await resume(host, "routine");
    const asked = dialogs.length;
    for (const [operation, payload] of PAGE_STEPS) {
      await rejectsWith(host.handleControlOperation(operation, payload), "private_address_blocked");
    }
    assert.equal(dialogs.length, asked, "nothing asked");
    const { tabs } = await host.handleControlOperation("list_tabs", {});
    assert.equal(tabs[1].url, "", "its address is not shown");
    // The agent may take the tab somewhere else, and reads that page as usual.
    await host.handleControlOperation("navigate", { url: "https://news.example.test/" });
    await host.handleControlOperation("snapshot", {});
  }
  // A public answer marks nothing.
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  host.pauseAgentControl();
  await headersReceived(views[1].webContents, { resourceType: "xhr", url: "https://news.example.test/api", ip: "93.184.216.36" });
  await beforeRequest(views[1].webContents, { resourceType: "webSocket", url: "wss://news.example.test/socket" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await resume(host, "routine");
  await host.handleControlOperation("snapshot", {});
});

test("while the person has control, a page load the agent's page starts is judged by the page it ends on", async () => {
  const { host, views } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
  const agentContents = views[1].webContents;
  host.pauseAgentControl();
  // A hop through a private address that ends on a public page leaves that page readable.
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "http://10.0.0.9/sso" })), {});
  assert.equal(await pageNavigates(agentContents, "https://shop.example.test/"), "loaded");
  await resume(host, "routine");
  await host.handleControlOperation("snapshot", {});
});

test("a page the agent opened that takes its tab to a private address while the person has control is not read after Resume", async () => {
  for (const url of ["http://192.168.1.1/", "https://rebound.example.test/admin"]) {
    const { host, views } = fixture();
    await resume(host, "routine");
    await host.handleControlOperation("open_tab", { url: "https://docs.example.test/" });
    const agentContents = views[1].webContents;
    host.pauseAgentControl();
    // The person's control: the page's own navigation goes ahead, unfiltered.
    assert.equal(await pageNavigates(agentContents, url), "loaded", url);
    // And so does every page that one opens in turn.
    assert.equal(await pageNavigates(agentContents, "https://shop.example.test/"), "loaded");
    assert.equal(await pageNavigates(agentContents, url), "loaded", url);
    await resume(host, "routine");
    await rejectsWith(host.handleControlOperation("snapshot", {}), "private_address_blocked");
    const { status } = await host.handleControlOperation("status", {});
    assert.equal(status.url, "", "its address is not shown either");
    assert.equal(status.title, undefined);
    // A page the person opens there from the address bar is theirs.
    host.pauseAgentControl();
    await host.navigate(url);
    await resume(host, "routine");
    await host.handleControlOperation("snapshot", {});
  }
});

test("a form the agent submits to a link-only site or a private address is refused before any prompt", async () => {
  const { host, dialogs, personView } = fixture();
  await resume(host, "ask");
  await host.handleControlOperation("snapshot", {});
  const button = (formActionUrl) => ({
    tag: "button", type: "submit", text: "Search", formOwnerIdentity: "document-0:form", formActionText: "Search",
    formActionUrl, formMethod: "get",
  });
  const field = (formActionUrl) => ({
    tag: "input", type: "text", name: "destination", formOwnerIdentity: "document-0:form", formActionText: "Search",
    formActionUrl, formMethod: "get",
  });
  for (const [action, code] of [
    ["https://www.booking.com/searchresults.html", "link_only_site"],
    ["http://192.168.1.1/login", "private_address_blocked"],
    ["https://rebind.example.test/post", "private_address_blocked"],
  ]) {
    for (const [descriptor, operation, payload] of [
      [button(action), "click", { index: 0 }],
      [button(action), "press", { index: 0, key: "Enter" }],
      [field(action), "press", { index: 0, key: "Enter" }],
      [field(action), "type", { index: 0, text: "Lisbon", submit: true }],
    ]) {
      personView.webContents.targetDescriptor = descriptor;
      await host.handleControlOperation("snapshot", {});
      const asked = dialogs.length;
      await rejectsWith(host.handleControlOperation(operation, payload), code);
      assert.equal(dialogs.length, asked, `${operation} to ${action} asked nothing`);
    }
  }
  assert.equal(personView.webContents.clicks ?? 0, 0);
  assert.equal(personView.webContents.typed ?? 0, 0);
  assert.equal(personView.webContents.presses ?? 0, 0);
  // A form of the page's own site asks as before.
  personView.webContents.targetDescriptor = button("https://example.test/search");
  await host.handleControlOperation("snapshot", {});
  const asked = dialogs.length;
  await host.handleControlOperation("click", { index: 0 });
  assert.equal(dialogs.length, asked + 1);
  assert.equal(personView.webContents.clicks, 1);
});

test("a stopped page load is reported to the next step as its previous step's, so that step is not taken as refused", async () => {
  const { host, personView } = fixture();
  await resume(host, "routine");
  await host.handleControlOperation("snapshot", {});
  assert.equal(await pageNavigates(personView.webContents, "https://www.booking.com/"), "prevented");
  await assert.rejects(host.handleControlOperation("snapshot", {}), (error) => {
    assert.equal(error.code, "link_only_site");
    assert.match(error.message, /previous step/);
    assert.match(error.message, /this step was not run/i);
    return true;
  });
  await host.handleControlOperation("snapshot", {});
});
