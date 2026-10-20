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
const control = require(path.join(packageRoot, "dist/personalBrowserControlServer.js"));
const hostCode = ts.transpileModule(
  fs.readFileSync(path.join(packageRoot, "src/personalBrowserHost.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(choose = async () => ({ response: 1 }), pageOverrides = {}, hostOptions = {}) {
  const dialogs = [];
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
        return choose(options);
      } },
    },
    "./browserTabCapture": require(path.join(packageRoot, "dist/browserTabCapture.js")),
    "./browserTabInput": require(path.join(packageRoot, "dist/browserTabInput.js")),
    "./browserTabExplorePage": { createBrowserTabExplorePage() { throw new Error("Unexpected native Explore page"); } },
    "./personalBrowserSecurity": security,
    "./personalBrowserRedaction": require(path.join(packageRoot, "dist/personalBrowserRedaction.js")),
    "./personalBrowserActionPolicy": require(path.join(packageRoot, "dist/personalBrowserActionPolicy.js")),
    "./personalBrowserPageBridge": { ...pageBridge, clearPersonalBrowserHumanInput: async () => {}, ...pageOverrides },
    "./personalBrowserHumanInput": {},
    "./personalBrowserInputShield": { PersonalBrowserInputShield: InputShield },
    "./personalBrowserControlServer": { ...control, PersonalBrowserControlServer: ControlServer },
  };
  vm.runInNewContext(hostCode, {
    module, exports: module.exports, URL, setTimeout, clearTimeout,
    require: (specifier) => dependencies[specifier] ?? require(specifier),
  });
  const host = new module.exports.PersonalBrowserHost({ enabled: true, onReleaseExpiry() {}, ...hostOptions });
  host.ownerWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ width: 800, height: 600 }),
  };
  host.view = { webContents: {
    isDestroyed: () => false,
    getURL: () => "https://example.test/",
    getTitle: () => "Disposable page",
    isLoading: () => false,
    stop() {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  } };
  host.currentState = "ready";
  host.currentProjectId = "project-fixture";
  host.currentPartition = "partition-fixture";
  host.currentOwnerId = "owner-fixture";
  return { host, dialogs };
}

test("Personal routine grant requires native consent and ends synchronously on Pause", async () => {
  const { host, dialogs } = fixture();
  const epoch = await host.prepareAgentControl("routine");
  host.enablePreparedAgentControl(epoch);
  assert.equal(host.getStatus().approvalMode, "routine");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].defaultId, 0);
  assert.equal(dialogs[0].cancelId, 0);
  assert.equal(await host.requestOriginApproval("https://another.example"), true);
  assert.equal(dialogs.length, 1, "routine grant should not ask again for another site");
  host.enablePreparedAgentControl(await host.prepareAgentControl());
  assert.equal(host.getStatus().approvalMode, "routine", "an idempotent enabled call preserves the live grant");
  assert.equal(dialogs.length, 1);
  host.pauseAgentControl();
  assert.equal(host.getStatus().approvalMode, "ask");
  assert.equal(host.getStatus().agentControlEnabled, false);
  assert.equal(host.getControlCredentials("project-fixture"), null);
  host.enablePreparedAgentControl(await host.prepareAgentControl());
  assert.equal(host.getStatus().approvalMode, "ask", "a later Resume must not inherit routine trust");
});

for (const { mode, formAction, confirmSubmission, title } of [
  { mode: "routine", formAction: "Search", confirmSubmission: false },
  // The dialog title names the step's category.
  { mode: "ask", formAction: "Search", confirmSubmission: true, title: "Change something" },
  { mode: "routine", formAction: "Place order", confirmSubmission: true, title: "Purchase or payment" },
]) {
  test(`type-and-submit uses ${mode} approval for the post-typing ${formAction} form`, async () => {
    const descriptor = { found: true, disabled: false, identity: "fixture-document:1", tag: "input", type: "text", formOwnerIdentity: "fixture-form", formActionText: "Search" };
    const keys = [];
    const { host, dialogs } = fixture(undefined, {
      snapshotPersonalBrowserPage: async () => ({
        url: "https://example.test/", documentToken: "fixture-document",
        interactive: [{ index: 0, tag: "input", type: "text", identity: descriptor.identity, descriptor: { ...descriptor } }],
      }),
      inspectPersonalBrowserTarget: async () => ({ ...descriptor }),
      typeIntoPersonalBrowserTarget: async () => {
        descriptor.formActionText = formAction;
        return { typed: true, targetChanged: false, descriptor: { ...descriptor } };
      },
      pressPersonalBrowserTarget: async (_contents, _target, key) => {
        keys.push(key);
        return { pressed: true, targetChanged: false };
      },
    });
    host.enablePreparedAgentControl(await host.prepareAgentControl(mode));
    await host.handleControlOperation("snapshot", {});
    const priorDialogs = dialogs.length;
    const result = await host.handleControlOperation("type", { index: 0, text: "Ada Lovelace", submit: true });
    assert.equal(result.submitted, true);
    assert.deepEqual(keys, ["Enter"]);
    assert.equal(dialogs.length - priorDialogs, confirmSubmission ? 1 : 0);
    if (confirmSubmission) assert.equal(dialogs.at(-1).title, title);
  });
}

test("Personal routine grant cannot survive native denial or a raced revocation", async () => {
  const denied = fixture(async () => ({ response: 0 }));
  await assert.rejects(denied.host.prepareAgentControl("routine"), /not approved/);
  assert.equal(denied.host.getStatus().approvalMode, "ask");
  assert.equal(denied.host.getControlCredentials("project-fixture"), null);

  let resolve;
  const raced = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = raced.host.prepareAgentControl("routine");
  raced.host.pauseAgentControl();
  resolve({ response: 1 });
  await assert.rejects(pending, /session changed/);
  assert.equal(raced.host.getStatus().approvalMode, "ask");
  assert.equal(raced.host.getControlCredentials("project-fixture"), null);
});

test("Personal routine mode cannot be changed in place or approved for another owner", async () => {
  const active = fixture();
  active.host.enablePreparedAgentControl(await active.host.prepareAgentControl());
  await assert.rejects(active.host.prepareAgentControl("routine"), /Pause Personal Browser/);
  assert.equal(active.dialogs.length, 0);

  let resolve;
  const changed = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = changed.host.prepareAgentControl("routine");
  changed.host.currentOwnerId = "different-owner";
  resolve({ response: 1 });
  await assert.rejects(pending, /session changed/);
  assert.equal(changed.host.getStatus().approvalMode, "ask");
});


test("browser tools occlusion and hiding a pane preserve an explicit share and viewport", async () => {
  const { host } = fixture();
  const visibility = [], dimensions = [];
  host.ownerWindow.webContents = { focus() {} };
  host.view.setVisible = value => visibility.push(value);
  host.view.setBounds = value => dimensions.push(value);
  host.view.webContents.capturePage = async () => ({ getSize: () => ({width:400,height:300}), toJPEG: () => new Uint8Array([1,2,3]) });
  const bounds = {x:10,y:20,width:400,height:300,visible:true};
  host.setBounds(bounds);
  const {captureId} = host.startTabShare("owner-fixture");
  host.setBounds({...bounds,occluded:true});
  assert.equal(visibility.at(-1),false);
  assert.deepEqual([...await host.captureSharedTab("owner-fixture",captureId)],[1,2,3]);
  host.setBounds({...bounds,occluded:false});
  assert.equal(visibility.at(-1),true);
  assert.ok(dimensions.every(value => value.width===400 && value.height===300));
  host.setBounds({...bounds,visible:false});
  assert.deepEqual([...await host.captureSharedTab("owner-fixture",captureId)],[1,2,3]);
  host.stopTabShare("owner-fixture",captureId);
});


test("menu previews are bounded to the current owner and discarded after closing or rebinding", async () => {
  const {host} = fixture();
  host.currentOccluded = true;
  const image = {getSize:()=>({width:400,height:300}),toJPEG:()=>Buffer.from([1,2,3])};
  host.view.webContents.capturePage = async () => image;
  assert.equal(await host.captureOverlayPreview("owner-fixture"),"data:image/jpeg;base64,AQID");
  assert.equal(await host.captureOverlayPreview("another-owner"),undefined);
  host.view.webContents.capturePage = async () => ({...image,toJPEG:()=>Buffer.alloc(1024*1024+1)});
  assert.equal(await host.captureOverlayPreview("owner-fixture"),undefined,"oversized previews are discarded");
  let resized;
  host.view.webContents.capturePage = async () => ({getSize:()=>({width:3200,height:2400}),resize:value=>{resized=value;return image}});
  assert.equal(await host.captureOverlayPreview("owner-fixture"),"data:image/jpeg;base64,AQID");
  assert.equal(resized.width,1600);
  assert.equal(resized.height,1200);
  let resolve;
  host.view.webContents.capturePage = () => new Promise(done=>{resolve=done});
  const pending = host.captureOverlayPreview("owner-fixture");
  assert.equal(await host.captureOverlayPreview("owner-fixture"),undefined,"only one preview may be pending");
  host.currentOwnerId = "another-owner";
  resolve(image);
  assert.equal(await pending,undefined);
  host.currentOwnerId = "owner-fixture";
  const closed = host.captureOverlayPreview("owner-fixture");
  host.currentOccluded = false;
  resolve(image);
  assert.equal(await closed,undefined);
});

test("an explicit tab share survives hiding its pane but not owner or project replacement", async () => {
  const { host } = fixture();
  host.currentVisible = true;
  host.view.webContents.capturePage = async () => ({ getSize: () => ({ width: 800, height: 600 }), toJPEG: () => new Uint8Array([1, 2]) });
  const { captureId } = host.startTabShare("owner-fixture");
  host.currentVisible = false;
  assert.deepEqual(await host.tabCapture.frame("owner-fixture", captureId), new Uint8Array([1, 2]));
  assert.throws(() => host.startTabShare("owner-fixture"), /Open your browser/);
  host.currentProjectId = "another-project";
  await assert.rejects(host.tabCapture.frame("owner-fixture", captureId), /sharing ended/);
  host.currentProjectId = "project-fixture";
  host.currentOwnerId = null;
  await assert.rejects(host.tabCapture.frame("owner-fixture", captureId), /sharing ended/);
  host.tabCapture.stop();
});

const CANARY = ["sk", "test", ["INSTAFY", "CANARY", "7Qm2Xr9Lp4Vb8Nc1"].join("")].join("_");
const NO_SECRET_SIGNALS = { credentialContext: false, secretField: false, secretCode: false, maskedNearReveal: false };

function snapshotPage({ documentToken = "doc-a", text = "", title = "Page", url = "https://example.test/", signals = NO_SECRET_SIGNALS, names = [] } = {}) {
  return {
    url, title, text, documentToken, signals,
    capturedAt: "2026-10-20T00:00:00.000Z",
    interactive: names.map((name, index) => ({
      index, tag: "button", name, disabled: false, identity: `${documentToken}:${index}`,
      descriptor: { found: true, identity: `${documentToken}:${index}`, tag: "button", text: name },
    })),
  };
}

for (const mode of ["ask", "routine"]) {
  test(`snapshots and status are masked in ${mode} mode and the canary reaches no output or log`, async () => {
    const logs = [];
    let page = snapshotPage({
      text: `Order 1234. Your key ${CANARY} was created.`,
      title: `Key ${CANARY}`,
      names: [`Copy ${CANARY}`, "Continue"],
    });
    const { host } = fixture(undefined, { snapshotPersonalBrowserPage: async () => page }, {
      logger: (...entry) => logs.push(entry),
    });
    host.view.webContents.getURL = () => page.url;
    host.view.webContents.getTitle = () => `Key ${CANARY}`;
    host.enablePreparedAgentControl(await host.prepareAgentControl(mode));
    const result = await host.handleControlOperation("snapshot", {});
    assert.ok(result.snapshot.text.includes("Order 1234."));
    assert.ok(result.snapshot.text.includes("[redacted secret]"));
    assert.equal(result.snapshot.interactive[0].name, "Copy [redacted secret]");
    const status = await host.handleControlOperation("status", {});
    host.logger("warn", "[instafy-desktop] personal-browser-approved-navigation-failed", {
      message: `ERR_ABORTED loading 'https://example.test/x?token=${CANARY}'`,
    });
    for (const output of [result, status, logs]) {
      assert.ok(!JSON.stringify(output).includes(CANARY), JSON.stringify(output));
    }
    page = snapshotPage({ documentToken: "doc-b", text: "Welcome back" });
    assert.equal((await host.handleControlOperation("snapshot", {})).snapshot.text, "Welcome back");
  });
}

test("a secret screen stays withheld until a new page loads", async () => {
  let page = snapshotPage({
    text: "API-Schlüssel",
    names: ["Anzeigen"],
    signals: { ...NO_SECRET_SIGNALS, secretField: true },
  });
  const { host } = fixture(undefined, { snapshotPersonalBrowserPage: async () => page });
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  let result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.secretScreen, true);
  assert.equal(result.snapshot.text, "");
  assert.equal(result.snapshot.interactive[0].name, "Anzeigen", "Octo can still name the control");

  page = snapshotPage({ text: "Nothing to see", names: ["Anzeigen"] });
  result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.secretScreen, true, "the same document stays withheld after the value is hidden");
  assert.equal(result.snapshot.text, "");

  page = snapshotPage({ documentToken: "doc-next", text: "Dashboard" });
  result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.secretScreen, undefined);
  assert.equal(result.snapshot.text, "Dashboard");
});

test("a page whose secret signals are missing is withheld", async () => {
  const page = snapshotPage({ text: "Unchecked text", names: ["Continue"] });
  delete page.signals;
  const { host } = fixture(undefined, { snapshotPersonalBrowserPage: async () => page });
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.secretScreen, true);
  assert.equal(result.snapshot.text, "");
  assert.equal(result.snapshot.url, "");
  assert.equal(result.snapshot.interactive[0].name, undefined, "unchecked names are dropped");
});

function stepFixture(descriptor, mode, choose) {
  const target = { found: true, disabled: false, identity: "doc-a:0", ...descriptor };
  const calls = { clicks: 0, keys: [], typed: 0 };
  let page = snapshotPage();
  page.interactive = [{ index: 0, tag: target.tag, name: target.text, disabled: false, identity: target.identity, descriptor: { ...target } }];
  const harness = fixture(choose, {
    snapshotPersonalBrowserPage: async () => page,
    inspectPersonalBrowserTarget: async () => ({ ...target }),
    clickPersonalBrowserTarget: async () => { calls.clicks += 1; return { clicked: true, targetChanged: false, descriptor: { ...target } }; },
    typeIntoPersonalBrowserTarget: async () => { calls.typed += 1; return { typed: true, targetChanged: false, descriptor: { ...target } }; },
    pressPersonalBrowserTarget: async (_contents, _target, key) => { calls.keys.push(key); return { pressed: true, targetChanged: false }; },
  });
  return { ...harness, calls, mode, setPage: (next) => { page = next; } };
}

for (const mode of ["ask", "routine"]) {
  for (const { name, operation, payload, descriptor, code } of [
    { name: "a reveal control in a credential row", operation: "click", payload: {}, code: "step_refused_secret",
      descriptor: { tag: "button", type: "button", text: "Anzeigen", credentialContext: true, row: true } },
    { name: "a sign-in submit", operation: "click", payload: {}, code: "step_refused_sign_in",
      descriptor: { tag: "button", type: "submit", text: "Sign in", formOwnerIdentity: "doc-a:form", formHasPassword: true, formFieldCount: 2 } },
    { name: "a file chooser", operation: "click", payload: {}, code: "step_refused_upload",
      descriptor: { tag: "input", type: "file", ariaLabel: "Attachment" } },
    { name: "the username of a sign-in form", operation: "type", payload: { text: "someone" }, code: "step_refused_sign_in",
      descriptor: { tag: "input", type: "email", autocomplete: "username", formOwnerIdentity: "doc-a:form", formHasPassword: true, formFieldCount: 2 } },
  ]) {
    test(`${mode} mode refuses ${name} without a dialog`, async () => {
      const { host, dialogs, calls } = stepFixture(descriptor, mode);
      host.enablePreparedAgentControl(await host.prepareAgentControl(mode));
      await host.handleControlOperation("snapshot", {});
      const before = dialogs.length;
      await assert.rejects(
        host.handleControlOperation(operation, { index: 0, ...payload }),
        (error) => error.statusCode === 403 && error.code === code,
      );
      assert.equal(dialogs.length, before, "a refusal shows no dialog");
      assert.equal(calls.clicks + calls.typed, 0);
    });
  }
}

test("Enter in a chat box outside any form asks in Ask mode and names the category", async () => {
  const { host, dialogs, calls } = stepFixture(
    { tag: "div", role: "textbox", ariaLabel: "Message", contentEditable: true },
    "ask",
  );
  host.enablePreparedAgentControl(await host.prepareAgentControl("ask"));
  await host.handleControlOperation("snapshot", {});
  const before = dialogs.length;
  await host.handleControlOperation("press", { index: 0, key: "Enter" });
  assert.equal(dialogs.length - before, 1);
  assert.equal(dialogs.at(-1).title, "Send a message");
  assert.deepEqual(calls.keys, ["Enter"]);
});

test("an approval dialog shows both labels when the accessible name and visible text differ", async () => {
  const { host, dialogs } = stepFixture({ tag: "button", type: "button", ariaLabel: "Delete workspace", text: "Open" }, "ask");
  host.enablePreparedAgentControl(await host.prepareAgentControl("ask"));
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 0 });
  assert.equal(dialogs.at(-1).title, "Delete, cancel or sign out");
  assert.match(dialogs.at(-1).message, /“Delete workspace” \(shown on the page as “Open”\)/);
});

test("after a step that may show a secret, the page and the page it opens stay withheld", async () => {
  const fixtureState = stepFixture(
    { tag: "tr", text: "Instafy api-instafy ••••", row: true, credentialContext: true, nearMaskedText: true },
    "routine",
  );
  const { host, calls, setPage } = fixtureState;
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 0 });
  assert.equal(calls.clicks, 1);

  setPage(snapshotPage({ documentToken: "doc-a", text: "Same page, dialog closed" }));
  assert.equal((await host.handleControlOperation("snapshot", {})).snapshot.secretScreen, true);
  setPage(snapshotPage({ documentToken: "doc-b", text: "The page the row opened" }));
  const opened = (await host.handleControlOperation("snapshot", {})).snapshot;
  assert.equal(opened.secretScreen, true);
  assert.equal(opened.text, "");
  setPage(snapshotPage({ documentToken: "doc-c", text: "A later page" }));
  assert.equal((await host.handleControlOperation("snapshot", {})).snapshot.text, "A later page");
});
