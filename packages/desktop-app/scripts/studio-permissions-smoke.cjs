// Native proof of the Studio session's geolocation policy (studioPermissions.ts)
// in real Electron: a cross-origin preview frame is refused -- even with
// allow="geolocation" and even after Studio was allowed -- while Studio's own
// top frame gets one (mocked) question, remembered. Positions come from a
// DevTools geolocation override, so the OS location provider is never asked.
// A control window without the handlers shows the frame is granted by default.
const { app, BrowserWindow, session } = require("electron");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-studio-permissions-smoke-"));
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const servers = [];
const windows = [];
function finish(code) {
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  for (const server of servers) server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => {
  console.error("Studio permissions smoke timed out");
  finish(1);
}, 60000).unref();

function serve(html) {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  servers.push(server);
  return server;
}

const locate = `function locate(){return new Promise((resolve)=>navigator.geolocation.getCurrentPosition(
  (p)=>resolve({ok:true,lat:p.coords.latitude}),(e)=>resolve({ok:false,code:e.code}),{timeout:5000}))}`;
const frameHtml = `<script>${locate}
(async()=>{const state=(await navigator.permissions.query({name:"geolocation"})).state;
const result=location.hash==="#query"?null:await locate();
parent.postMessage({frame:true,state,result},"*");})();</script>`;

async function eventually(read, accept, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await pause(100);
  }
  throw Error(`Did not settle: ${label}`);
}

app
  .whenReady()
  .then(async () => {
    const { createStudioPermissionHandlers } = require("../dist/studioPermissions.js");
    const frameServer = serve(frameHtml);
    await new Promise((resolve) => frameServer.listen(0, "127.0.0.1", resolve));
    const frameUrl = `http://127.0.0.1:${frameServer.address().port}/`;
    // The worst case for the policy: the frame is explicitly delegated geolocation.
    const topServer = serve(`<script>${locate}window.locate=locate;window.frames_=[];
addEventListener("message",(e)=>{if(e.data&&e.data.frame)window.frames_.push(e.data)});
window.addFrame=(hash)=>{const f=document.createElement("iframe");f.allow="fullscreen; clipboard-write; geolocation";f.src=${JSON.stringify(frameUrl)}+(hash||"");document.body.appendChild(f)};</script>`);
    await new Promise((resolve) => topServer.listen(0, "localhost", resolve));
    const studioUrl = `http://localhost:${topServer.address().port}/`;
    const studioOrigin = new URL(studioUrl).origin;

    const open = async (partition) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      windows.push(window);
      await window.loadURL(studioUrl);
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Emulation.setGeolocationOverride", {
        latitude: 52.37,
        longitude: 4.89,
        accuracy: 10,
      });
      return window;
    };
    const js = (window, code) => window.webContents.executeJavaScript(code, true);
    const frameResults = (window, count) =>
      eventually(() => js(window, "window.frames_"), (v) => v.length >= count, "frame result");

    // Control: no handler on the session -> Electron grants the framed site.
    const control = await open("studio-permissions-smoke-control");
    await js(control, `addFrame("#query")`);
    const [controlFrame] = await frameResults(control, 1);
    assert.equal(controlFrame.state, "granted", "control: Electron's default grants the frame");
    console.log("control (no handler): framed site geolocation state =", controlFrame.state);

    // Studio session with the real handlers; the native dialog is mocked.
    let consent = null;
    const answers = [];
    let asked = 0;
    let studio;
    const handlers = createStudioPermissionHandlers({
      getStudioOrigin: () => studioOrigin,
      isStudioContents: (contents) => Boolean(studio) && contents === studio.webContents,
      readConsent: () => consent,
      writeConsent: (next) => {
        consent = next;
      },
      askUser: async () => {
        asked += 1;
        await pause(300);
        return answers.shift();
      },
    });
    const studioSession = session.fromPartition("studio-permissions-smoke-studio");
    studioSession.setPermissionRequestHandler(handlers.requestHandler);
    studioSession.setPermissionCheckHandler(handlers.checkHandler);
    studio = await open("studio-permissions-smoke-studio");

    // 1. A framed site, before anything was answered: refused, no question.
    await js(studio, "addFrame()");
    const [before] = await frameResults(studio, 1);
    assert.equal(before.state, "denied");
    assert.deepEqual(before.result, { ok: false, code: 1 });
    assert.equal(asked, 0, "a subframe never raises the question");
    console.log("cross-origin frame before consent:", before.state, "code", before.result.code, "questions", asked);

    // 2. Studio's top frame: one question for two concurrent requests.
    answers.push(true);
    const [first, second] = await js(studio, "Promise.all([locate(), locate()])");
    assert.deepEqual(first, { ok: true, lat: 52.37 });
    assert.deepEqual(second, { ok: true, lat: 52.37 });
    assert.equal(asked, 1);
    assert.equal(consent?.decision, "granted");
    // 3. Remembered: granted silently.
    assert.deepEqual(await js(studio, "locate()"), { ok: true, lat: 52.37 });
    assert.equal(asked, 1);
    assert.equal(await js(studio, `navigator.permissions.query({name:"geolocation"}).then(s=>s.state)`), "granted");
    console.log("studio top frame: allowed after", asked, "question; repeat request silent");

    // 4. The framed site is still refused after Studio was allowed.
    await js(studio, "addFrame()");
    const [, after] = await frameResults(studio, 2);
    assert.equal(after.state, "denied");
    assert.deepEqual(after.result, { ok: false, code: 1 });
    assert.equal(asked, 1);
    console.log("cross-origin frame after consent:", after.state, "code", after.result.code);

    // 5. Reset, answer Don't Allow: remembered, no second question.
    handlers.resetLocationPermission();
    answers.push(false);
    assert.deepEqual(await js(studio, "locate()"), { ok: false, code: 1 });
    assert.deepEqual(await js(studio, "locate()"), { ok: false, code: 1 });
    assert.equal(asked, 2);
    assert.equal(consent?.decision, "denied");
    console.log("after reset + Don't Allow: top frame denied, questions", asked);

    console.log("Studio permissions smoke passed");
    finish(0);
  })
  .catch((error) => {
    console.error(error);
    finish(1);
  });
