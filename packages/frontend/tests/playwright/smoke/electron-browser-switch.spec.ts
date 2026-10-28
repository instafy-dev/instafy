import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { personalBrowserFixtureEnvironment } from "../../../scripts/browser-ci.mjs";
import { captureElectronBrowserWindow } from "../utils/electronBrowserScreenshots";
import { chooseBrowserLocation, openBrowserOptions } from "../utils/browserLocation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const desktop = path.join(root, "packages/desktop-app");
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const origin = "http://127.0.0.1:5305";
const nativeUrl = `${origin}/native-page`;

async function choose(page: Page, mode: "shared" | "personal") {
  await chooseBrowserLocation(page, mode);
}

async function paint(page: Page) {
  await expect(page.getByTestId("synthetic-rfb-canvas")).toBeAttached();
  await page.evaluate(() => window.__nativeBrowserSwitchReview.paint());
  await expect(page.getByTestId("synthetic-rfb-canvas")).toHaveAttribute("data-painted", "true");
  await expect(page.getByTestId("browser-session-frozen-frame")).toHaveCount(0);
}

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"] as const) {
    // Electron owns its context; no Playwright browser/page fixture is used.
    // eslint-disable-next-line no-empty-pattern
    test(`${width}px ${theme}: native Personal handoff preserves the page through repeated switches and resize`, async ({}, info) => {
      if (!fs.existsSync(path.join(desktop, "dist/main.js"))) throw new Error("Build @instafy/desktop-app before running this explicit Electron lane.");
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-native-switch-"));
      const app = await electron.launch({
        executablePath: desktopRequire("electron"), args: [desktop], cwd: root,
        env: {
          ...personalBrowserFixtureEnvironment(process.env),
          TMPDIR: os.tmpdir(),
          INSTAFY_APP_URL: `${origin}/tests/fixtures/electron-browser-switch/index.html?manual=1&theme=${theme}`,
          INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
          INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST: "1",
          INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
        },
      });
      try {
        const page = await app.firstWindow();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.waitForURL(/\/tests\/fixtures\/electron-browser-switch\/index\.html/).catch(async reason => {
          fs.writeFileSync(info.outputPath("startup-state.json"), JSON.stringify({ urls: app.windows().map(window => window.url()), errors, text: await page.locator("body").innerText().catch(() => "") }));
          throw reason;
        });
        await page.waitForLoadState("domcontentloaded");
        await app.evaluate(({ BrowserWindow }, size) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setMinimumSize(320, 400);
          window.setContentSize(size.width, size.height);
        }, { width, height: 900 });
        await expect(page.locator("main[data-native-state]")).toHaveAttribute("data-native-state", "ready", { timeout: 20_000 });
        await expect(page.getByRole("alert")).toHaveCount(0);
        await paint(page);

        const snapshot = async (name: string, includePersonal = false) => {
          const capture = await captureElectronBrowserWindow(app, page, { includePersonal, personalBrowserUrl: nativeUrl });
          const label = includePersonal ? `${name}-composed` : name;
          fs.writeFileSync(info.outputPath(`${label}.png`), capture.windowPng);
          await info.attach(label, { body: capture.windowPng, contentType: "image/png" });
        };
        const nativeState = () => app.evaluate(async ({ webContents }, url) => {
          const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
          if (!contents) throw new Error("Real Personal WebContentsView not found.");
          return { id: contents.id, ...await contents.executeJavaScript("({ draft: document.getElementById('draft').value, scrollY, title: document.title })") };
        }, nativeUrl);
        await snapshot("shared-ready");
        await choose(page, "personal");
        await expect.poll(() => page.evaluate(() => window.instafyDesktop!.personalBrowserStatus!().then(status => status.visible))).toBe(true);
        await app.evaluate(async ({ webContents }, url) => {
          const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url)!;
          await contents.executeJavaScript("document.getElementById('draft').value='Keep this draft across switching'; window.scrollTo(0, 260)");
        }, nativeUrl);
        const initial = await nativeState();
        expect(initial.draft).toBe("Keep this draft across switching");
        expect(initial.scrollY).toBe(260);
        await snapshot("personal-ready", true);

        // Delay only completion of a real native capture. The production IPC,
        // native image, first-occlusion behavior and surface remain unchanged.
        // Resize sends a later bounds reply before that first image resolves.
        await app.evaluate(({ webContents }, url) => {
          const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url)!;
          const original = contents.capturePage.bind(contents);
          const fixture = globalThis as unknown as { releaseSwitchCapture?: () => void; switchCaptureStarted?: boolean };
          contents.capturePage = async (...args) => {
            const image = await original(...args);
            fixture.switchCaptureStarted = true;
            await new Promise<void>(resolve => { fixture.releaseSwitchCapture = resolve; });
            contents.capturePage = original;
            return image;
          };
        }, nativeUrl);
        await openBrowserOptions(page);
        await expect.poll(() => app.evaluate(() => Boolean((globalThis as unknown as { switchCaptureStarted?: boolean }).switchCaptureStarted))).toBe(true);
        await app.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0]!.setContentSize(width + 24, 900); }, width);
        // Wait for the ResizeObserver/native bounds path while capture is held.
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width + 24);
        const resizedViewport = await page.getByTestId("personal-browser-viewport").boundingBox();
        expect(resizedViewport).not.toBeNull();
        await expect.poll(() => app.evaluate(({ BrowserWindow }, url) => {
          const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(candidate =>
            (candidate as { webContents?: { getURL(): string } }).webContents?.getURL() === url);
          // Hidden Chromium defers its DOM resize. Native View bounds establish
          // that the later IPC geometry report actually reached the host.
          return view?.getBounds().width;
        }, nativeUrl)).toBe(Math.round(resizedViewport!.width));
        await app.evaluate(() => { (globalThis as unknown as { releaseSwitchCapture?: () => void }).releaseSwitchCapture?.(); });
        await expect(page.getByTestId("personal-browser-overlay-preview")).toBeVisible();
        await snapshot("personal-menu-resize");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("personal-browser-overlay-preview")).toHaveCount(0);
        expect(await nativeState()).toEqual(initial);
        await app.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900); }, width);

        for (let cycle = 0; cycle < 3; cycle += 1) {
          await choose(page, "shared");
          await expect.poll(() => page.evaluate(() => window.instafyDesktop!.personalBrowserStatus!().then(status => status.visible))).toBe(false);
          await expect(page.getByTestId("browser-session-frozen-frame")).toBeVisible();
          await expect(page.getByTestId("synthetic-rfb-canvas")).toHaveAttribute("data-connected", "true");
          const frozen = page.getByTestId("browser-session-frozen-frame");
          await expect.poll(() => frozen.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
          expect(await page.getByTestId("synthetic-rfb-canvas").evaluate(canvas => getComputedStyle(canvas.parentElement!).opacity)).toBe("0");
          if (cycle === 0) await snapshot("shared-reconnecting");
          // One quick return before Shared paints exercises interrupted handoff.
          if (cycle !== 1) await paint(page);
          await choose(page, "personal");
          await expect.poll(() => page.evaluate(() => window.instafyDesktop!.personalBrowserStatus!().then(status => status.visible))).toBe(true);
          expect(await nativeState()).toEqual(initial);
          await expect(page.getByTestId("personal-browser-overlay-preview")).toHaveCount(0);
        }
        await snapshot("personal-returned", true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await app.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  }
}
