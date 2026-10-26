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
  "rebind.example.test": ["10.0.0.5"],
};
async function lookup(host) {
  const addresses = DNS[host];
  if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family: 4 }));
}

let nextContentsId = 1;

class FakeContents {
  constructor(views) {
    this.views = views;
    this.id = nextContentsId++;
    this.url = "";
    this.title = "";
    this.handlers = {};
    this.destroyed = false;
    this.loads = [];
    this.session = {
      setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, on() {},
      webRequest: { onBeforeRequest: (filter, listener) => { this.session.beforeRequestFilter = filter; this.session.beforeRequest = listener; } },
    };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, clear() {} };
  }
  on(name, handler) { (this.handlers[name] ??= []).push(handler); return this; }
  emit(name, ...args) { for (const handler of this.handlers[name] ?? []) handler(...args); }
  setWindowOpenHandler() {}
  async loadURL(url) {
    this.loads.push(url);
    this.url = url;
    this.title = url === "about:blank" ? "" : `Page at ${new URL(url).host}`;
    this.emit("did-navigate", {}, url);
    this.emit("did-finish-load");
  }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isDestroyed() { return this.destroyed; }
  isLoading() { return false; }
  stop() {}
  focus() {}
  close() { this.destroyed = true; }
}

function fixture({ choose = async () => ({ response: 1 }) } = {}) {
  const dialogs = [];
  const views = [];
  const shield = { attached: [], syncs: [] };
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
      this.webContents = new FakeContents(views);
      this.visible = true;
      this.bounds = null;
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
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
        documentToken: `document-${views.findIndex((view) => view.webContents === contents)}`,
        signals: NO_SECRET_SIGNALS,
        interactive: [{
          index: 0, tag: "a", name: "More", identity: `document-${views.findIndex((view) => view.webContents === contents)}:0`,
          descriptor: { found: true, disabled: false, tag: "a", identity: `document-${views.findIndex((view) => view.webContents === contents)}:0`, text: "More" },
        }],
        capturedAt: "2026-10-26T09:30:00.000Z",
      }),
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
  // The person's own tab, already on a page.
  const personView = new WebContentsView();
  personView.webContents.url = "https://example.test/";
  personView.webContents.title = "Person's page";
  host.view = personView;
  host.currentState = "ready";
  host.currentVisible = true;
  host.currentProjectId = "project-fixture";
  host.currentPartition = "partition-fixture";
  host.currentOwnerId = "owner-fixture";
  return { host, dialogs, views, shield, personView };
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

test("navigate in an agent tab keeps to public addresses; the person's own tab is unchanged", async () => {
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
  assert.deepEqual(plain(agentContents.session.beforeRequestFilter.types), ["mainFrame", "subFrame"]);
  // A link the agent clicks, or a redirect, to a public name that resolves to the local network.
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://rebind.example.test/admin" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "subFrame", url: "https://rebind.example.test/" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://unknown.example.test/" })), { cancel: true });
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "mainFrame", url: "https://news.example.test/" })), { cancel: false });
  // The page's own resources and the person's tab are not filtered here.
  assert.deepEqual(plain(await beforeRequest(agentContents, { resourceType: "image", url: "https://rebind.example.test/a.png" })), {});
  assert.deepEqual(
    plain(await beforeRequest(agentContents, { webContentsId: personView.webContents.id, resourceType: "mainFrame", url: "https://rebind.example.test/" })),
    {},
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
