// Explicit native qualification: requires a working Electron desktop session.
const { app, BrowserWindow, nativeImage, session } = require("electron");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "instafy-explore-smoke-"),
);
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const pages = [],
  windows = [];
let server;
const deadline = setTimeout(() => {
  console.error("Native Explore smoke timed out");
  finish(1);
}, 30_000);
function finish(code) {
  clearTimeout(deadline);
  for (const page of pages) page.close();
  server?.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}
async function eventually(read, accept) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Native Explore state did not settle");
}
app
  .whenReady()
  .then(async () => {
    const {
      createBrowserTabExplorePage,
    } = require("../dist/browserTabExplorePage.js");
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.setHeader("set-cookie", "shared=fixture; Path=/");
      res.end(
        req.url === "/next"
          ? "<style>body{margin:0;background:#ed3020}</style><h1>Next page</h1>"
          : '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#d7efdc}a{display:block;padding:20px}input{display:block;margin:20px}</style><a href="/next">Go next</a><input aria-label="Draft"><div style="height:2000px">Scroll</div>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const ownerSession = session.fromPartition("native-explore-smoke");
    for (const viewport of [
      { width: 1056, height: 650, dpr: 1 },
      { width: 390, height: 650, dpr: 2 },
    ]) {
      pages.push(
        createBrowserTabExplorePage(ownerSession, url, viewport, (options) => {
          const window = new BrowserWindow(options);
          windows.push(window);
          return window;
        }),
      );
    }
    const frames = await Promise.all(
      pages.map((page) => eventually(() => page.frame(), Boolean)),
    );
    assert.deepEqual(
      frames.map((frame) => nativeImage.createFromBuffer(frame).getSize()),
      [
        { width: 1056, height: 650 },
        { width: 780, height: 1300 },
      ],
    );
    const metrics = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript(
          "({width:innerWidth,height:innerHeight,cookie:document.cookie,scrollY})",
        ),
      ),
    );
    assert.deepEqual(
      metrics.map((m) => m.width),
      [1056, 390],
    );
    assert.ok(metrics.every((m) => m.cookie === "shared=fixture"));
    // The click overlaps capture, reproducing a hidden CDP screenshot freeze.
    await pages[1].input({ type: "click", x: 0.15, y: 0.04 }, () => true);
    await eventually(
      () => pages[1].frame(),
      (frame) => {
        if (!frame) return false;
        const image = nativeImage
          .createFromBuffer(frame)
          .resize({ width: 1, height: 1 });
        const [blue, green, red] = image.toBitmap();
        return red > 180 && green < 100 && blue < 100;
      },
    );
    assert.equal(windows[1].webContents.getURL(), url + "next");
    assert.equal(windows[0].webContents.getURL(), url);
    await pages[1].navigate("back");
    await eventually(
      async () => ({
        url: windows[1].webContents.getURL(),
        frame: await pages[1].frame(),
      }),
      (result) => result.url === url && result.frame,
    );
    await pages[1].navigate("reload");
    await eventually(() => pages[1].frame(), Boolean);
    await pages[1].resize({ width: 500, height: 700, dpr: 1 });
    const resized = await eventually(
      () => pages[1].frame(),
      (frame) =>
        frame && nativeImage.createFromBuffer(frame).getSize().width === 500,
    );
    assert.deepEqual(nativeImage.createFromBuffer(resized).getSize(), {
      width: 500,
      height: 700,
    });
    assert.equal(
      await windows[0].webContents.executeJavaScript("innerWidth"),
      1056,
    );
    pages[1].close();
    assert.equal(windows[1].isDestroyed(), true);
    assert.ok(await pages[0].frame());
    console.log(
      "Native Explore passed: independent metrics, shared cookie, navigation during capture, Back, Reload, resize and close.",
    );
    finish(0);
  })
  .catch((error) => {
    console.error(error);
    finish(1);
  });
