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
const hostCode = ts.transpileModule(
  fs.readFileSync(path.join(packageRoot, "src/personalBrowserHost.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(choose = async () => ({ response: 1 })) {
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
    "./personalBrowserPageBridge": { clearPersonalBrowserHumanInput: async () => {} },
    "./personalBrowserHumanInput": {},
    "./personalBrowserInputShield": { PersonalBrowserInputShield: InputShield },
    "./personalBrowserControlServer": { PersonalBrowserControlServer: ControlServer },
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


test("browser tools occlusion preserves sharing and viewport, but leaving the browser ends capture", async () => {
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
  await assert.rejects(host.captureSharedTab("owner-fixture",captureId), /sharing ended/);
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
