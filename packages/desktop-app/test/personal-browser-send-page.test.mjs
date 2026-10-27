import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Send page to Octo on the Personal Browser: the owner's page is read once and
// masked in Electron main before anything leaves Desktop, and reading it
// grants the agent nothing.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const pageBridge = require(path.join(packageRoot, "dist/personalBrowserPageBridge.js"));
const control = require(path.join(packageRoot, "dist/personalBrowserControlServer.js"));
const hostCode = ts.transpileModule(
  fs.readFileSync(path.join(packageRoot, "src/personalBrowserHost.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const NO_SECRET_SIGNALS = { credentialContext: false, secretField: false, secretCode: false, maskedNearReveal: false };
// Key-shaped samples are assembled at run time, so none is committed whole.
const join = (...parts) => parts.join("");
const KEY = join("sk", "-proj-", "AbCdEfGhIjKlMnOp", "QrStUvWxYz0123456789");
const RANDOM_VALUE = join("abc123DEF456", "ghi789JKL012mno345");

function fixture(page) {
  const dialogs = [];
  const snapshots = [];
  class ControlServer {
    credentials = null;
    getCredentials() { return this.credentials; }
    async bindProject(projectId) { this.credentials = { projectId }; }
    clearBinding() { this.credentials = null; }
  }
  class InputShield { sync() {} }
  const module = { exports: {} };
  const dependencies = {
    electron: {
      WebContentsView: class {},
      dialog: { showMessageBox: async (_owner, options) => {
        dialogs.push(options);
        return { response: 1 };
      } },
    },
    "./browserTabCapture": require(path.join(packageRoot, "dist/browserTabCapture.js")),
    "./browserTabInput": require(path.join(packageRoot, "dist/browserTabInput.js")),
    "./browserTabExplorePage": { createBrowserTabExplorePage() { throw new Error("Unexpected native Explore page"); } },
    // Agent navigation resolves its host: here every fixture name is public, and nothing reaches the network.
    "./personalBrowserSecurity": { ...security, checkPersonalBrowserAgentTabUrl: (url) => security.checkPersonalBrowserAgentTabUrl(url, publicLookup) },
    "./personalBrowserLinkOnly": require(path.join(packageRoot, "dist/personalBrowserLinkOnly.js")),
    "./personalBrowserRequestGuard": require(path.join(packageRoot, "dist/personalBrowserRequestGuard.js")),
    "./personalBrowserRedaction": require(path.join(packageRoot, "dist/personalBrowserRedaction.js")),
    "./personalBrowserActionPolicy": require(path.join(packageRoot, "dist/personalBrowserActionPolicy.js")),
    "./personalBrowserTeammateActivity": require(path.join(packageRoot, "dist/personalBrowserTeammateActivity.js")),
    "./personalBrowserPageBridge": {
      ...pageBridge,
      clearPersonalBrowserHumanInput: async () => {},
      snapshotPersonalBrowserPage: async () => {
        const snapshot = {
          url: page.url,
          title: page.title,
          text: page.text,
          documentToken: page.documentToken ?? "document-1",
          signals: page.signals === undefined ? NO_SECRET_SIGNALS : page.signals,
          interactive: [],
          capturedAt: "2026-10-26T09:30:00.000Z",
        };
        snapshots.push(snapshot);
        page.afterSnapshot?.();
        return snapshot;
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
  };
  host.view = { webContents: {
    isDestroyed: () => false,
    getURL: () => page.currentUrl ?? page.url,
    getTitle: () => page.title,
    isLoading: () => false,
    stop() {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  } };
  host.currentState = "ready";
  host.currentProjectId = "project-fixture";
  host.currentPartition = "partition-fixture";
  host.currentOwnerId = "owner-fixture";
  return { host, dialogs, snapshots };
}

test("a sent Personal page is masked in Electron main before it leaves Desktop", async () => {
  const { host } = fixture({
    url: `https://shop.example/orders/42?session=${KEY}`,
    title: "Order 42",
    text: `Your order ships Monday. Deploy hook: ${KEY}`,
  });
  const page = await host.readPageForOwner("owner-fixture");
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes(KEY), serialized);
  assert.match(page.text, /Your order ships Monday\. Deploy hook: \[redacted secret\]/);
  assert.equal(page.title, "Order 42");
  assert.match(page.url, /^https:\/\/shop\.example\/orders\/42\?session=REDACTED$/);
  assert.equal(page.secretScreen, false);
  assert.equal(page.truncated, false);
  assert.equal(page.readAt, "2026-10-26T09:30:00.000Z");
});

test("a secret screen, a withheld page or a failed check sends no text", async () => {
  const secretScreen = fixture({
    url: "https://console.example/settings/api-keys",
    title: "API keys",
    text: `Production key ${RANDOM_VALUE}`,
    signals: { ...NO_SECRET_SIGNALS, credentialContext: true },
  });
  const shown = await secretScreen.host.readPageForOwner("owner-fixture");
  assert.equal(shown.secretScreen, true);
  assert.equal(shown.text, "");
  assert.equal(shown.title, "");

  const failedCheck = fixture({ url: "https://example.test/", title: "Plain", text: "Nothing secret.", signals: null });
  const failed = await failedCheck.host.readPageForOwner("owner-fixture");
  assert.equal(failed.secretScreen, true);
  assert.equal(failed.text, "");

  // A page the agent's snapshots withhold stays withheld here too.
  const withheld = fixture({ url: "https://example.test/", title: "Plain", text: "Nothing secret.", documentToken: "doc-held" });
  withheld.host.withheldDocumentTokens.add("doc-held");
  const page = await withheld.host.readPageForOwner("owner-fixture");
  assert.equal(page.secretScreen, true);
  assert.equal(page.text, "");
});

test("long pages are cut after masking, so a key at the limit is never half sent", async () => {
  const { host } = fixture({
    url: "https://example.test/long",
    title: "Long",
    text: `${"a ".repeat(24_990)}${KEY} tail`,
  });
  const page = await host.readPageForOwner("owner-fixture");
  assert.equal(page.truncated, true);
  assert.equal(page.text.length, 50_000);
  assert.ok(!page.text.includes("sk-proj-"), "no part of the key survives the cut");
});

test("sending a page grants no standing read and no agent authority", async () => {
  const { host, dialogs, snapshots } = fixture({ url: "https://example.test/", title: "Plain", text: "Nothing secret." });
  const before = {
    status: JSON.stringify(host.getStatus()),
    approvedOrigins: [...host.approvedOrigins],
    controlEpoch: host.controlEpoch,
  };
  await host.readPageForOwner("owner-fixture");
  await host.readPageForOwner("owner-fixture");

  assert.equal(snapshots.length, 2, "every send reads the page anew; nothing is kept");
  assert.equal(host.getStatus().agentControlEnabled, false);
  assert.equal(JSON.stringify(host.getStatus()), before.status);
  assert.deepEqual([...host.approvedOrigins], before.approvedOrigins, "no site is approved for the agent");
  assert.equal(host.controlEpoch, before.controlEpoch);
  assert.equal(host.latestAgentSnapshot, null, "the agent gets no snapshot targets to act on");
  assert.equal(host.getControlCredentials("project-fixture"), null, "no broker capability exists");
  assert.equal(host.withheldDocumentTokens.size, 0, "reading marks nothing");
  assert.equal(dialogs.length, 0);
  // The agent still has to take its own snapshot, under its own approval.
  await assert.rejects(() => host.handleControlOperation("click", { index: 0 }));
});

test("only the current owner can read, only a web page, and only one document", async () => {
  const { host } = fixture({ url: "https://example.test/", title: "Plain", text: "Text" });
  await assert.rejects(() => host.readPageForOwner("someone-else"), /not ready/);

  const blank = fixture({ url: "about:blank", title: "", text: "" });
  await assert.rejects(() => blank.host.readPageForOwner("owner-fixture"), /Open a web page first/);

  const page = { url: "https://example.test/a", title: "A", text: "Text" };
  page.afterSnapshot = () => { page.currentUrl = "https://example.test/b"; };
  const moving = fixture(page);
  await assert.rejects(() => moving.host.readPageForOwner("owner-fixture"), /changed while it was read/);
});
