import { expect, test, type Page } from "@playwright/test";
import { browserSwitchBoundaries } from "../../fixtures/browser-transport-switch/boundaries";
import { chooseBrowserLocation, openBrowserOptions } from "../utils/browserLocation.js";

test.use({ deviceScaleFactor: 2 });

// Real production surfaces and location picker; synthetic data/pixel transport
// and native bridge. This checks DOM frame retention and native IPC ordering,
// not a remote runtime, native mobile browser, or Electron compositor paint.
async function mount(page: Page, theme: "light" | "dark", rosterDelay = 0, fallback = false) {
  for (const [path, body] of Object.entries(browserSwitchBoundaries)) {
    if (path === "/src/sdk/instafy") continue;
    const matcher = path === "@novnc/novnc/lib/rfb"
      ? /.*novnc.*\/lib\/rfb(?:\.js)?(?:\?.*)?$/
      : `**${path}*`;
    await page.route(matcher, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.goto(`/tests/fixtures/browser-transport-switch/index.html?manual=1&theme=${theme}&rosterDelay=${rosterDelay}&fallback=${fallback ? 1 : 0}`);
  await expect(page.getByTestId("synthetic-rfb-canvas")).toBeAttached();
  await paint(page);
}

for (const fallback of [false, true]) {
test(fallback
  ? "retains the Shared frame through a waiting CDP fallback until fresh ownership restores RFB"
  : "retains the Shared frame while a fresh collaboration roster resolves on return", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mount(page, "dark", 800, fallback);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await choose(page, "personal");
    await expect(page.getByTestId("synthetic-native-page")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.rosterState)).toBe("idle");
    const previousConnections = await page.evaluate(() => window.__browserSwitchReview.connections.length);
    const previousCdpMounts = await page.evaluate(() => window.__browserSwitchReview.cdpMounts);
    await choose(page, "shared");
    await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.rosterState)).toBe("connecting");
    const frozen = page.getByTestId("browser-session-frozen-frame");
    await expect(frozen).toBeVisible();
    expect(await page.evaluate(() => window.__browserSwitchReview.connections.length)).toBe(previousConnections);
    await expect(page.getByTestId("synthetic-rfb-canvas")).toHaveCount(0);
    if (fallback) {
      await expect(page.locator("[data-shared-browser-viewer]")).toHaveAttribute("data-shared-browser-viewer", "cdp-screencast");
      await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.cdpMounts)).toBeGreaterThan(previousCdpMounts);
      await expect(frozen).toBeVisible();
    }

    await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.rosterState)).toBe("connected");
    await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.connections.length)).toBe(previousConnections + 1);
    await expect(page.getByTestId("synthetic-rfb-canvas")).toHaveAttribute("data-connected", "true");
    await expect(page.locator("[data-shared-browser-viewer]")).toHaveAttribute("data-shared-browser-viewer", "rfb");
    await expect(frozen).toBeVisible();
    await paint(page);
  }
  expect(errors).toEqual([]);
});
}

async function paint(page: Page) {
  await page.evaluate(() => window.__browserSwitchReview.paint());
  await expect(page.getByTestId("synthetic-rfb-canvas")).toHaveAttribute("data-painted", "true");
  await expect(page.getByTestId("browser-session-frozen-frame")).toHaveCount(0);
}

async function choose(page: Page, mode: "shared" | "personal") {
  await chooseBrowserLocation(page, mode);
}

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: repeated Shared/Personal switching retains the last frame until repaint`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await mount(page, theme);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await choose(page, "personal");
        await expect(page.getByTestId("synthetic-native-page")).toBeVisible();
        // Where the browser runs is in its Options menu, not the toolbar.
        await expect(page.getByTestId("browser-location-menu")).toHaveCount(0);
        await openBrowserOptions(page);
        await expect(page.getByTestId("browser-transport-personal")).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("personal-browser-overlay-preview")).toBeVisible();
        await page.evaluate(() => {
          window.__browserSwitchReview.bounds.length = 0;
          window.__browserSwitchReview.holdBridgeReplies = true;
        });
        await page.keyboard.press("Escape");
        // Keep the captured page while the native restoration reply is pending.
        await expect(page.getByTestId("personal-browser-overlay-preview")).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.bounds.some(bounds => bounds.visible && !bounds.occluded))).toBe(true);
        expect(await page.evaluate(() => window.__browserSwitchReview.bounds.every(bounds => bounds.visible))).toBe(true);
        await page.evaluate(() => window.__browserSwitchReview.releaseBridgeReplies());
        await expect(page.getByTestId("personal-browser-overlay-preview")).toHaveCount(0);

        const previousConnections = await page.evaluate(() => window.__browserSwitchReview.connections.length);
        await choose(page, "shared");
        await expect(page.getByTestId("synthetic-native-page")).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.__browserSwitchReview.connections.length)).toBe(previousConnections + 1);
        const canvas = page.getByTestId("synthetic-rfb-canvas");
        await expect(canvas).toHaveAttribute("data-connected", "true");
        await expect(canvas).not.toHaveAttribute("data-painted", "true");
        const frozen = page.getByTestId("browser-session-frozen-frame");
        await expect(frozen).toBeVisible();
        // The handshake happened, but its black canvas must remain covered.
        await expect.poll(() => canvas.evaluate(element => getComputedStyle(element.parentElement!).opacity)).toBe("0");
        await expect.poll(() => frozen.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
        await paint(page);
        await expect(canvas).toBeVisible();
        expect(await canvas.evaluate(element => getComputedStyle(element.parentElement!).opacity)).toBe("1");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
