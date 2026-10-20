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

const NO_SECRET_SIGNALS = { credentialContext: false, secretField: false, secretCode: false, maskedNearReveal: false };

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
    "./personalBrowserTeammateActivity": require(path.join(packageRoot, "dist/personalBrowserTeammateActivity.js")),
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

// Routine is the owner tier: these cases are rewritten on purpose from the
// earlier routine, which submitted ordinary forms without asking.
for (const { name, mode, field, after, dialogs: expectedDialogs, title } of [
  { name: "a same-site GET search", mode: "routine", after: "Search", dialogs: 0,
    field: { type: "search", formMethod: "get", formActionText: "Search" } },
  { name: "an ordinary form in Ask mode", mode: "ask", after: "Search", dialogs: 1, title: "Change something",
    field: { type: "text", formActionText: "Search" } },
  { name: "an ordinary form", mode: "routine", after: "Save", dialogs: 1, title: "Change something",
    field: { type: "text", formActionText: "Save" } },
  // Typing changed what the form does: the submission asks again.
  { name: "a form that became an order while typing", mode: "routine", after: "Place order", dialogs: 2, title: "Purchase or payment",
    field: { type: "text", formActionText: "Search" } },
]) {
  test(`type-and-submit in ${mode} mode on ${name} asks ${expectedDialogs} time(s)`, async () => {
    const descriptor = { found: true, disabled: false, identity: "fixture-document:1", tag: "input", formOwnerIdentity: "fixture-document:form", ...field };
    const keys = [];
    const { host, dialogs } = fixture(undefined, {
      snapshotPersonalBrowserPage: async () => ({
        url: "https://example.test/", documentToken: "fixture-document", signals: NO_SECRET_SIGNALS,
        interactive: [{ index: 0, tag: "input", type: field.type, identity: descriptor.identity, descriptor: { ...descriptor } }],
      }),
      inspectPersonalBrowserTarget: async () => ({ ...descriptor }),
      typeIntoPersonalBrowserTarget: async () => {
        descriptor.formActionText = after;
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
    assert.equal(dialogs.length - priorDialogs, expectedDialogs);
    if (expectedDialogs > 0) assert.equal(dialogs.at(-1).title, title);
    if (expectedDialogs > 0) assert.match(dialogs[priorDialogs].message, /fill in and submit/);
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

// Not a known key format: only the withheld-page rule can catch it.
const OPAQUE_CANARY = ["Zq8v", "N3xR", "7mKp", "W2tY", "9bLc", "4HdS"].join("");

test("a control named by an unknown-format value is masked once the page is withheld", async () => {
  let page = snapshotPage({ names: [OPAQUE_CANARY, "Done"], signals: { ...NO_SECRET_SIGNALS, secretField: true } });
  const { host } = fixture(undefined, { snapshotPersonalBrowserPage: async () => page });
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  let result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.secretScreen, true);
  assert.deepEqual(result.snapshot.interactive.map((entry) => entry.name), ["[redacted secret]", "Done"]);
  // The same document stays withheld after the signal goes away.
  page = snapshotPage({ names: [`Copy ${OPAQUE_CANARY}`] });
  result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.interactive[0].name, "Copy [redacted secret]");
  assert.ok(!JSON.stringify(result).includes(OPAQUE_CANARY));
});

test("a step that may show a secret withholds the page even when the click fails afterwards", async () => {
  const target = { found: true, disabled: false, identity: "doc-a:0", tag: "button", type: "button", text: "Token erstellen" };
  let page = snapshotPage();
  page.interactive = [{ index: 0, tag: "button", name: target.text, disabled: false, identity: target.identity, descriptor: { ...target } }];
  const { host } = fixture(undefined, {
    snapshotPersonalBrowserPage: async () => page,
    inspectPersonalBrowserTarget: async () => ({ ...target }),
    // The in-page click ran, then the page reported the target as gone.
    clickPersonalBrowserTarget: async () => ({ clicked: false, targetChanged: false, descriptor: { ...target } }),
  });
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  await host.handleControlOperation("snapshot", {});
  await assert.rejects(host.handleControlOperation("click", { index: 0 }), (error) => error.code === "target_not_clickable");
  page = snapshotPage({ documentToken: "doc-a", text: "Your new key is ready" });
  const result = await host.handleControlOperation("snapshot", {});
  assert.equal(result.snapshot.secretScreen, true);
  assert.equal(result.snapshot.text, "");
});

test("status masks the title from its own words and masks a load error", async () => {
  const sha = "3f2a9c1e8b7d4e6fa5b4c3d2e1f0a9b812345678";
  const { host } = fixture();
  host.view.webContents.getTitle = () => `API token ${sha}`;
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  host.currentError = `ERR_CONNECTION_REFUSED loading 'https://example.test/x?token=${CANARY}'`;
  const status = await host.handleControlOperation("status", {});
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(sha), serialized);
  assert.ok(!serialized.includes(CANARY), serialized);
  assert.ok(serialized.includes("ERR_CONNECTION_REFUSED"));
});

// --- Routine as the owner tier (approval policy version 2) ---

function pageFixture(targets, choose, { url = "https://example.test/list" } = {}) {
  const calls = { clicks: [], typed: [], keys: [], loads: [] };
  const byIndex = targets.map((descriptor, index) => ({
    found: true, disabled: false, identity: `doc-a:${index}`, ...descriptor,
  }));
  const harness = fixture(choose, {
    snapshotPersonalBrowserPage: async () => ({
      ...snapshotPage({ url }),
      interactive: byIndex.map((descriptor, index) => ({
        index, tag: descriptor.tag, name: descriptor.text, disabled: false, identity: descriptor.identity, descriptor: { ...descriptor },
      })),
    }),
    inspectPersonalBrowserTarget: async (_contents, { index }) => ({ ...byIndex[index] }),
    clickPersonalBrowserTarget: async (_contents, { index }) => { calls.clicks.push(index); return { clicked: true, targetChanged: false }; },
    typeIntoPersonalBrowserTarget: async (_contents, { index }) => {
      calls.typed.push(index);
      return { typed: true, targetChanged: false, descriptor: { ...byIndex[index] } };
    },
    pressPersonalBrowserTarget: async (_contents, { index }, key) => { calls.keys.push([index, key]); return { pressed: true, targetChanged: false }; },
  });
  harness.host.view.webContents.getURL = () => url;
  harness.host.view.webContents.loadURL = async (target) => { calls.loads.push(target); };
  return { ...harness, calls };
}

function navigationEvent() {
  const event = { prevented: false, preventDefault() { event.prevented = true; } };
  return event;
}

async function settle() {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("status reports approval policy version 2", () => {
  const { host } = fixture();
  assert.equal(host.getStatus().approvalPolicyVersion, 2);
  assert.deepEqual([...host.getStatus().approvalModes], ["ask", "routine"]);
});

test("a routine start shows one three-button dialog that lists the card's hosts", async () => {
  const { host, dialogs } = fixture();
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine", ["App.Example.test", "bad host", "docs.example.test"]));
  assert.equal(dialogs.length, 1);
  assert.deepEqual([...dialogs[0].buttons], ["Cancel", "Allow", "Ask me each step"]);
  assert.equal(dialogs[0].defaultId, 0);
  assert.equal(dialogs[0].cancelId, 0);
  assert.match(dialogs[0].detail, /Sites on this card: app\.example\.test, docs\.example\.test\./);
  assert.doesNotMatch(dialogs[0].detail, /bad host/);
  assert.equal(host.getStatus().approvalMode, "routine");
  // No site prompt anywhere in routine, including a site that is not on the card.
  assert.equal(await host.requestOriginApproval("https://elsewhere.test"), true);
  assert.equal(dialogs.length, 1);
});

test("Ask me each step starts the run in Ask mode instead of failing it", async () => {
  const { host, dialogs } = fixture(async (options) => ({ response: options.buttons.length === 3 ? 2 : 1 }));
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine", ["example.test"]));
  assert.equal(host.getStatus().agentControlEnabled, true);
  assert.equal(host.getStatus().approvalMode, "ask");
  assert.equal(await host.requestOriginApproval("https://elsewhere.test"), true);
  assert.equal(dialogs.length, 2, "Ask mode prompts for a new site");
  assert.equal(dialogs[1].title, "Allow agent browser access?");
});

test("card hosts are ignored outside routine", async () => {
  const { host, dialogs } = fixture();
  host.enablePreparedAgentControl(await host.prepareAgentControl("ask", ["example.test"]));
  assert.equal(dialogs.length, 0);
  assert.equal(host.runKnownHosts.length, 0);
});

test("routine: a typed address on a new site is free, a risky address asks with its category", async () => {
  const { host, dialogs, calls } = pageFixture([], async () => ({ response: 1 }));
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const before = dialogs.length;
  await host.handleControlOperation("navigate", { url: "https://other.example/page?d=hello" });
  assert.equal(dialogs.length, before, "no new-site prompt in routine");
  assert.deepEqual(calls.loads, ["https://other.example/page?d=hello"]);

  await host.handleControlOperation("navigate", { url: "https://other.example/logout" });
  assert.equal(dialogs.length, before + 1);
  assert.equal(dialogs.at(-1).title, "Delete, cancel or sign out");

  const denied = pageFixture([], async (options) => ({ response: options.buttons.length === 3 ? 1 : 0 }));
  denied.host.enablePreparedAgentControl(await denied.host.prepareAgentControl("routine"));
  await assert.rejects(
    denied.host.handleControlOperation("navigate", { url: "https://other.example/export/2026.csv" }),
    (error) => error.code === "navigation_denied",
  );
  assert.equal(denied.dialogs.at(-1).title, "Download or export");
  assert.deepEqual(denied.calls.loads, []);
});

for (const mode of ["ask", "routine"]) {
  test(`${mode}: a page-started navigation or redirect to a risky address is held until approved`, async () => {
    const { host, dialogs, calls } = pageFixture([], async () => ({ response: 1 }));
    host.enablePreparedAgentControl(await host.prepareAgentControl(mode));
    const before = dialogs.length;
    const ordinary = navigationEvent();
    host.guardPageNavigation(ordinary, "https://example.test/next");
    assert.equal(ordinary.prevented, false);

    const risky = navigationEvent();
    host.guardPageNavigation(risky, "https://example.test/account/logout");
    assert.equal(risky.prevented, true);
    await settle();
    assert.equal(dialogs.length, before + 1);
    assert.equal(dialogs.at(-1).title, "Delete, cancel or sign out");
    assert.deepEqual(calls.loads, ["https://example.test/account/logout"]);
  });
}

test("routine: a denied risky redirect never loads", async () => {
  const { host, calls } = pageFixture([], async (options) => ({ response: options.buttons.length === 3 ? 1 : 0 }));
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const event = navigationEvent();
  host.guardPageNavigation(event, "https://example.test/invite/Qx7vN2mR8tLp4Wz9Kd3s");
  assert.equal(event.prevented, true);
  await settle();
  assert.deepEqual(calls.loads, []);
});

test("routine: plain links are free and an approved risky link does not ask again when it navigates", async () => {
  const { host, dialogs, calls } = pageFixture([
    { tag: "a", text: "Docs", href: "https://docs.example.test/start", linkSelf: true },
    { tag: "a", text: "Export", href: "https://example.test/reports/2026.csv", linkSelf: true },
  ]);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const before = dialogs.length;
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 0 });
  assert.equal(dialogs.length, before, "a plain link to another site is free");

  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 1 });
  assert.equal(dialogs.length, before + 1);
  assert.equal(dialogs.at(-1).title, "Download or export");
  const follow = navigationEvent();
  host.guardPageNavigation(follow, "https://example.test/reports/2026.csv");
  assert.equal(follow.prevented, false, "the approved click's own navigation is not asked about again");
  const again = navigationEvent();
  host.guardPageNavigation(again, "https://example.test/reports/2026.csv");
  assert.equal(again.prevented, true, "the approval is used once");
  assert.deepEqual(calls.clicks, [0, 1]);
});

test("routine: menus and navigation items are free, other buttons ask as a change", async () => {
  const { host, dialogs, calls } = pageFixture([
    { tag: "div", role: "menuitem", text: "Verbundene Apps", areas: "menu" },
    { tag: "button", type: "button", text: "Neuen Mandant anlegen" },
  ]);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const before = dialogs.length;
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 0 });
  assert.equal(dialogs.length, before);
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 1 });
  assert.equal(dialogs.length, before + 1);
  assert.equal(dialogs.at(-1).title, "Change something");
  assert.deepEqual(calls.clicks, [0, 1]);
});

for (const mode of ["ask", "routine"]) {
  test(`${mode}: one typing approval covers a form on this page; fields outside forms ask each`, async () => {
    const { host, dialogs, calls } = pageFixture([
      { tag: "input", type: "text", ariaLabel: "Name", formOwnerIdentity: "doc-a:form-1" },
      { tag: "input", type: "text", ariaLabel: "City", formOwnerIdentity: "doc-a:form-1" },
      { tag: "input", type: "text", ariaLabel: "Note A" },
      { tag: "input", type: "text", ariaLabel: "Note B" },
      { tag: "input", type: "search", ariaLabel: "Suche" },
    ]);
    host.enablePreparedAgentControl(await host.prepareAgentControl(mode));
    // Ask mode's site prompt comes with the first snapshot.
    await host.handleControlOperation("snapshot", {});
    const before = dialogs.length;
    const type = async (index) => {
      await host.handleControlOperation("snapshot", {});
      await host.handleControlOperation("type", { index, text: "x" });
    };
    await type(0);
    assert.equal(dialogs.length, before + 1);
    assert.equal(dialogs.at(-1).title, "Change something");
    assert.match(dialogs.at(-1).message, /fill in/);
    await type(1);
    await host.handleControlOperation("snapshot", {});
    await host.handleControlOperation("press", { index: 1, key: "Backspace" });
    assert.equal(dialogs.length, before + 1, "the form's approval covers its other fields and edit keys");
    await type(2);
    await type(3);
    assert.equal(dialogs.length, before + 3, "each field outside a form asks");
    await type(4);
    assert.equal(dialogs.length, before + 3, "a search field is free");
    assert.deepEqual(calls.typed, [0, 1, 2, 3, 4]);
  });
}

test("routine: a denied typing approval types nothing", async () => {
  const { host, calls } = pageFixture(
    [{ tag: "input", type: "text", ariaLabel: "Name", formOwnerIdentity: "doc-a:form-1" }],
    async (options) => ({ response: options.buttons.length === 3 ? 1 : 0 }),
  );
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  await host.handleControlOperation("snapshot", {});
  await assert.rejects(host.handleControlOperation("type", { index: 0, text: "x" }), (error) => error.code === "typing_denied");
  assert.deepEqual(calls.typed, []);
});

test("routine: a POST search asks to fill in and submit, Enter in a chat box asks as a message", async () => {
  const { host, dialogs, calls } = pageFixture([
    { tag: "input", type: "search", ariaLabel: "Search", formOwnerIdentity: "doc-a:form-1", formMethod: "post" },
    { tag: "div", role: "textbox", ariaLabel: "Message", contentEditable: true },
  ]);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const before = dialogs.length;
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("type", { index: 0, text: "invoices", submit: true });
  assert.equal(dialogs.length, before + 1);
  assert.match(dialogs.at(-1).message, /fill in and submit/);
  assert.match(dialogs.at(-1).detail, /The agent types: “invoices”\./, "the owner sees what the approval sends");
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("press", { index: 1, key: "Enter" });
  assert.equal(dialogs.length, before + 2);
  assert.equal(dialogs.at(-1).title, "Send a message");
  assert.deepEqual(calls.keys, [[0, "Enter"], [1, "Enter"]]);
});

test("a type-and-submit dialog shows the exact text, bounded, every time it asks", async () => {
  const { host, dialogs } = pageFixture([
    { tag: "textarea", ariaLabel: "Message", formOwnerIdentity: "doc-a:form-1", formSubmitLabels: "Send" },
  ]);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const before = dialogs.length;
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("type", { index: 0, text: "Hello\n  team", submit: true });
  assert.equal(dialogs.length, before + 1);
  assert.match(dialogs.at(-1).detail, /The agent types: “Hello team”\./);
  // The form's typing approval does not cover a second send with new text.
  const long = "x".repeat(400);
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("type", { index: 0, text: long, submit: true });
  assert.equal(dialogs.length, before + 2);
  assert.match(dialogs.at(-1).detail, /x{300}… \(400 characters\)/);
});

test("arrow keys in an editable combobox share the form's typing approval", async () => {
  const { host, dialogs, calls } = pageFixture([
    { tag: "input", type: "text", role: "combobox", ariaLabel: "Customer", formOwnerIdentity: "doc-a:form-1" },
  ]);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const before = dialogs.length;
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("type", { index: 0, text: "Acme" });
  assert.equal(dialogs.length, before + 1);
  for (const key of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
    await host.handleControlOperation("snapshot", {});
    await host.handleControlOperation("press", { index: 0, key });
  }
  assert.equal(dialogs.length, before + 1, "picking an option asks no more");
  assert.equal(calls.keys.length, 3);
});

test("a denied page-started navigation is reported to the agent's next operation once", async () => {
  const { host, calls } = pageFixture([], async (options) => ({ response: options.buttons.length === 3 ? 1 : 0 }));
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  const event = navigationEvent();
  host.guardPageNavigation(event, "https://example.test/account/logout");
  assert.equal(event.prevented, true);
  await settle();
  await assert.rejects(host.handleControlOperation("snapshot", {}), (error) => error.code === "navigation_denied");
  await host.handleControlOperation("snapshot", {});
  assert.deepEqual(calls.loads, []);
});

test("an approved link's navigation is matched with its query", async () => {
  const { host } = pageFixture([
    { tag: "a", text: "Report", href: "https://example.test/reports/2026.csv", linkSelf: true },
  ]);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  await host.handleControlOperation("snapshot", {});
  await host.handleControlOperation("click", { index: 0 });
  const other = navigationEvent();
  host.guardPageNavigation(other, "https://example.test/reports/2026.csv?scope=all");
  assert.equal(other.prevented, true, "another query is not the approved address");
  const own = navigationEvent();
  host.guardPageNavigation(own, "https://example.test/reports/2026.csv");
  assert.equal(own.prevented, false);
});

// --- Teammate activity in the owner's profile ---

const teammateStore = require(path.join(packageRoot, "dist/personalBrowserTeammateActivity.js"));

function teammateFixture(choose) {
  const store = teammateStore.createMemoryTeammateActivityStore();
  const harness = fixture(choose, {}, { teammateActivity: store });
  harness.host.currentVisible = true;
  harness.host.view.webContents.getURL = () => "https://bank.example.test/accounts";
  harness.host.view.webContents.loadURL = async () => {};
  return { ...harness, store };
}

function giveTeammateTabControl(host) {
  const { captureId } = host.startTabShare("owner-fixture");
  host.controlSharedTab("owner-fixture", captureId, "11111111-2222-4333-8444-555555555555");
  assert.equal(host.getStatus().tabControlActive, true);
  host.controlSharedTab("owner-fixture", captureId, null);
  host.stopTabShare("owner-fixture", captureId);
}

test("after a teammate had tab control, routine asks for each site except the card's hosts", async () => {
  const { host, dialogs, store } = teammateFixture();
  giveTeammateTabControl(host);
  assert.deepEqual([...store.read("partition-fixture").sites], ["bank.example.test"]);

  host.enablePreparedAgentControl(await host.prepareAgentControl("routine", ["example.test"]));
  const start = dialogs.at(-1);
  assert.match(start.detail, /A teammate used this browser profile \(sites: bank\.example\.test\)/);
  assert.equal(start.checkboxLabel, "Forget teammate activity");
  assert.equal(start.checkboxChecked, false);

  const before = dialogs.length;
  assert.equal(await host.requestOriginApproval("https://example.test"), true);
  assert.equal(await host.requestOriginApproval("https://www.example.test"), true);
  assert.equal(dialogs.length, before, "the card's hosts allowed in the start dialog do not ask");
  assert.equal(await host.requestOriginApproval("https://bank.example.test"), true);
  assert.equal(dialogs.length, before + 1, "every other site asks again");
  assert.match(dialogs.at(-1).detail, /A teammate used this browser profile/);
  // A redirect to an unapproved site is held as well.
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  host.guardPageNavigation(event, "https://sso.elsewhere.test/login");
  assert.equal(event.prevented, true);
});

test("Forget teammate activity in the start dialog brings back routine without site prompts", async () => {
  const { host, dialogs, store } = teammateFixture(async (options) => ({
    response: 1,
    checkboxChecked: options.checkboxLabel === "Forget teammate activity",
  }));
  giveTeammateTabControl(host);
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  assert.equal(store.read("partition-fixture"), null);
  const before = dialogs.length;
  assert.equal(await host.requestOriginApproval("https://bank.example.test"), true);
  assert.equal(dialogs.length, before);
});

test("a cancelled start keeps the teammate mark even with Forget ticked", async () => {
  const { host, store } = teammateFixture(async () => ({ response: 0, checkboxChecked: true }));
  giveTeammateTabControl(host);
  await assert.rejects(host.prepareAgentControl("routine"), /not approved/);
  assert.notEqual(store.read("partition-fixture"), null);
});

test("Clear data removes the teammate mark", async () => {
  const { host, store } = teammateFixture();
  giveTeammateTabControl(host);
  Object.assign(host.view.webContents, {
    loadURL: async () => {},
    navigationHistory: { ...host.view.webContents.navigationHistory, clear() {} },
    session: { clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {}, flushStorageData() {} },
  });
  await host.clearData();
  assert.equal(store.read("partition-fixture"), null);
});

test("Ask mode is unchanged by a teammate mark and an unmarked profile has no note", async () => {
  const { host, dialogs } = teammateFixture();
  host.enablePreparedAgentControl(await host.prepareAgentControl("routine"));
  assert.equal(dialogs.at(-1).checkboxLabel, undefined);
  assert.doesNotMatch(dialogs.at(-1).detail, /teammate/);
});
