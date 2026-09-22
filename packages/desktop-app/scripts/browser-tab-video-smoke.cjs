// Explicit native qualification; no accounts, external sites or screen capture.
const { app, BrowserWindow, session } = require("electron");
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-tab-video-smoke-"));
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, page, capture, renewal;
const windows = [];
function finish(code) {
  clearInterval(renewal);
  capture?.stop();
  page?.close();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  server?.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => {
  console.error("Native video smoke timed out");
  finish(1);
}, 45000).unref();
async function eventually(read, accept) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await pause(100);
  }
  throw Error("Native video did not settle");
}
app
  .whenReady()
  .then(async () => {
    const { createBrowserTabExplorePage } = require("../dist/browserTabExplorePage.js");
    const { BrowserTabCapture } = require("../dist/browserTabCapture.js");
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url === "/receiver"
          ? "<video autoplay muted playsinline></video>"
          : "<style>body{margin:0;font:18px system-ui}section{height:140px}section:nth-child(even){background:#d1e4f5}</style>" +
              Array.from(
                { length: 80 },
                (_, i) =>
                  `<section>Native video ${i}: independent layout and readable text</section>`,
              ).join("") +
              "<script>function tick(){scrollBy(0,3);requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>",
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let sourceWindow;
    const sourceSession = session.fromPartition("video-smoke-source");
    sourceSession.setPermissionCheckHandler(() => false);
    sourceSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(capture?.allowsVideoCapture(contents, permission, details) ?? false),
    );
    page = createBrowserTabExplorePage(
      sourceSession,
      url + "/",
      { width: 375, height: 650, dpr: 2 },
      (options) => {
        sourceWindow = new BrowserWindow(options);
        return sourceWindow;
      },
    );
    await eventually(() => page.frame(), Boolean);
    capture = new BrowserTabCapture(() => ({
      ownerId: "owner",
      projectId: "project",
      contents: sourceWindow.webContents,
      videoSource: page.videoSource,
    }));
    const { captureId } = capture.start("owner");
    const requests = [];
    renewal = setInterval(() => {
      void capture.videoOperation("owner", captureId, "sync", requests).catch(() => {});
    }, 1000);
    async function connect(dpr) {
      const id = randomUUID();
      const request = {
        id,
        viewId: null,
        viewport: { width: 375, height: 650, dpr },
        configuration: { iceServers: [], iceTransportPolicy: "all" },
      };
      requests.push(request);
      const receiver = new BrowserWindow({
        show: false,
        webPreferences: {
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      windows.push(receiver);
      await receiver.loadURL(url + "/receiver");
      const offer = await capture.videoOperation("owner", captureId, "open", request);
      const answer = await receiver.webContents.executeJavaScript(`(async()=>{
      window.pc=new RTCPeerConnection();pc.ontrack=e=>{document.querySelector('video').srcObject=e.streams[0]};
      await pc.setRemoteDescription({type:'offer',sdp:${JSON.stringify(offer)}});
      await pc.setLocalDescription(await pc.createAnswer());
      if(pc.iceGatheringState!=='complete')await new Promise(r=>pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')r()});
      return pc.localDescription.sdp;
    })()`);
      await capture.videoOperation("owner", captureId, "answer", { id, sdp: answer });
      await eventually(
        () =>
          receiver.webContents.executeJavaScript(
            `({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight})`,
          ),
        (v) => v.width > 0 && v.height > 0,
      );
      return { id, receiver };
    }
    const first = await connect(2),
      second = await connect(1);
    assert.equal(
      capture.allowsVideoCapture(sourceWindow.webContents, "media", {
        securityOrigin: "https://untrusted.example",
        mediaTypes: [],
        isMainFrame: true,
      }),
      false,
    );
    assert.equal(
      capture.allowsVideoCapture(sourceWindow.webContents, "media", {
        securityOrigin: "file:///",
        mediaTypes: ["video"],
        isMainFrame: true,
      }),
      false,
    );
    const size = (r) =>
      r.receiver.webContents.executeJavaScript(
        `({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight})`,
      );
    assert.deepEqual(await size(first), { width: 750, height: 1300 });
    await eventually(
      () => size(second),
      (v) => v.width >= 370 && v.width <= 376,
    );
    await pause(3000);
    const stats = await capture.videoOperation("owner", captureId, "stats", { id: first.id });
    const out = stats.find((s) => s.type === "outbound-rtp");
    assert.ok(out.framesEncoded > 0);
    console.log(
      JSON.stringify({
        phase: "portrait",
        width: out.frameWidth,
        height: out.frameHeight,
        fps: out.framesPerSecond,
        encoder: out.encoderImplementation,
        hardware: out.powerEfficientEncoder,
        bytes: out.bytesSent,
      }),
    );
    await page.navigate("reload");
    await pause(300);
    await page.resize({ width: 650, height: 375, dpr: 2 });
    await capture.videoOperation("owner", captureId, "viewport", {
      id: first.id,
      viewport: { width: 650, height: 375, dpr: 2 },
    });
    await capture.videoOperation("owner", captureId, "viewport", {
      id: second.id,
      viewport: { width: 650, height: 375, dpr: 1 },
    });
    await eventually(
      () => size(first),
      (v) => v.width === 1300 && v.height === 750,
    );
    await pause(3000);
    const rotated = (
      await capture.videoOperation("owner", captureId, "stats", { id: first.id })
    ).find((s) => s.type === "outbound-rtp");
    console.log(
      JSON.stringify({
        phase: "landscape",
        size: await size(first),
        fps: rotated.framesPerSecond,
        encoder: rotated.encoderImplementation,
        hardware: rotated.powerEfficientEncoder,
      }),
    );
    await page.resize({ width: 364, height: 464, dpr: 1 });
    await capture.videoOperation("owner", captureId, "viewport", {
      id: first.id,
      viewport: { width: 364, height: 464, dpr: 1 },
    });
    await eventually(
      () => size(first),
      (v) => v.width >= 358 && v.width <= 364 && v.height >= 456 && v.height <= 464,
    );
    await page.resize({ width: 390, height: 686, dpr: 1 });
    await capture.videoOperation("owner", captureId, "viewport", {
      id: first.id,
      viewport: { width: 390, height: 686, dpr: 1 },
    });
    const expanded = await eventually(
      () => size(first),
      (v) => v.width >= 384 && v.width <= 390 && v.height >= 676 && v.height <= 686,
    );
    console.log(JSON.stringify({ phase: "expanded", size: expanded }));
    const before = BrowserWindow.getAllWindows().length;
    requests.length = 0;
    await capture.videoOperation("owner", captureId, "sync", []);
    await eventually(
      () => BrowserWindow.getAllWindows().length,
      (n) => n === before - 1,
    );
    assert.equal(await capture.videoOperation("owner", captureId, "stats", { id: first.id }), null);
    await assert.rejects(
      capture.videoOperation("wrong-owner", captureId, "open", {
        id: randomUUID(),
        viewId: null,
        viewport: { width: 375, height: 650, dpr: 2 },
        configuration: { iceServers: [], iceTransportPolicy: "all" },
      }),
    );
    await page.resize({ width: 364, height: 464, dpr: 1 });
    const last = await connect(1);
    await page.resize({ width: 390, height: 686, dpr: 1 });
    await capture.videoOperation("owner", captureId, "viewport", {
      id: last.id,
      viewport: { width: 390, height: 686, dpr: 1 },
    });
    await eventually(
      () => size(last),
      (v) => v.width >= 384 && v.width <= 390 && v.height >= 676 && v.height <= 686,
    );
    clearInterval(renewal);
    await pause(4500);
    assert.equal(await capture.videoOperation("owner", captureId, "stats", { id: last.id }), null);
    console.log(
      "Native tab video passed: distinct receiver resolutions, hardware reporting, navigation, rotation, revocation and native lease expiry.",
    );
    finish(0);
  })
  .catch((error) => {
    console.error(error);
    finish(1);
  });
