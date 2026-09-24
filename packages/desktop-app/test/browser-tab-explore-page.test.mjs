import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTabExplorePage } from "../dist/browserTabExplorePage.js";

test("Explore waits for the initial page before attaching and setting metrics, then loads the approved URL", async () => {
  const events = [];
  let ready;
  let destroyed = false;
  let options;
  const contents = {
    loadURL: async (url) => {
      events.push(url);
      if (url === "about:blank")
        await new Promise((r) => {
          ready = r;
        });
    },
    setAudioMuted() {},
    setWindowOpenHandler() {},
    on() {},
    async capturePage(_rect, options) {
      assert.equal(options.stayHidden, true);
      return {
        getSize: () => ({ width: 780, height: 1300 }),
        toJPEG: () => Buffer.from([255, 216, 255, 217]),
      };
    },
    debugger: {
      attach() {
        events.push("attach");
      },
      async sendCommand(method) {
        events.push(method);
        return { data: Buffer.from([255, 216, 255, 217]).toString("base64") };
      },
    },
  };
  const fake = {
    webContents: contents,
    setContentSize() {},
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
  };
  const page = createBrowserTabExplorePage(
    {},
    "https://fixture.test/",
    { width: 390, height: 650, dpr: 2 },
    (value) => {
      options = value;
      return fake;
    },
  );
  assert.deepEqual(events, ["about:blank"]);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.show, false);
  ready();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.deepEqual(events, [
    "about:blank",
    "attach",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setFocusEmulationEnabled",
    "https://fixture.test/",
  ]);
  assert.ok(await page.frame());
  await page.resize({ width: 390, height: 650, dpr: 3 });
  // The fake exposes no resize method: requesting more density must not upscale
  // a native capture whose backing surface already tops out at 780 x 1300.
  assert.ok(await page.frame());
  const capture = contents.capturePage;
  contents.capturePage = async () => {
    throw new Error("UnknownVizError");
  };
  assert.equal(await page.frame(), null);
  assert.equal(await page.frame(), null);
  contents.capturePage = capture;
  assert.ok(await page.frame());
  contents.capturePage = async () => {
    throw new Error("UnknownVizError");
  };
  for (let i = 0; i < 3; i++) assert.equal(await page.frame(), null);
  await assert.rejects(page.frame(), /UnknownVizError/);
  contents.capturePage = async () => {
    throw new Error("renderer destroyed");
  };
  await assert.rejects(page.frame(), /renderer destroyed/);
  page.close();
  assert.equal(destroyed, true);
});
