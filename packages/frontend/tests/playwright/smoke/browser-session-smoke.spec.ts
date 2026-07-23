import { test, expect, type Page } from "@playwright/test";
import {
  prepareStudio,
  clearRuntimePreference,
  requestHostedRuntime,
  waitForHostedRuntimeReady,
  resetRuntimeUserState,
  expectAssistantReplyOrSkipRateLimit,
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000)
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

async function sampleBrowserSessionRegionText(
  page: Page,
  viewport: { width: number; height: number },
): Promise<string[]> {
  await page.setViewportSize(viewport);
  const region = page.getByRole("region", { name: "Browser session" });
  const samples: string[] = [];
  for (const delay of [0, 20, 50, 100, 200, 400]) {
    if (delay > 0) {
      await page.waitForTimeout(delay);
    }
    const text = ((await region.textContent()) ?? "").replace(/\s+/g, " ").trim();
    samples.push(text);
  }
  return samples;
}

test.describe("Browser session smoke", () => {
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );
  test.setTimeout(480_000);

  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    const projectId = await prepareStudio(page);
    activeProjectId = projectId;
    await clearRuntimePreference(page, { projectId, source: "browser-session-smoke" });
    await ensureHostedRuntimeReady(page, projectId);
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "browser-session-smoke:cleanup" }).catch(() => {});
  });

  test("opens remote browser session", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Project id missing for browser session smoke test.");
    }

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();
    await chatInput.fill("Open a browser session and go to https://example.com. Keep it visible inline.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("conversation-subtabs")).toBeVisible({ timeout: 300_000 });
    await page.getByTestId("conversation-subtab-chat").click();
    await expectAssistantReplyOrSkipRateLimit(page, /example\.com|Example Domain|browser session/i, {
      timeout: 300_000,
    });
    await page.getByTestId("conversation-subtab-browser").click();

    const modal = page.getByTestId("browser-session-modal");
    await expect(modal).toBeVisible({ timeout: 30_000 });

    const status = modal.getByTestId("browser-session-status");
    await expect(status).toBeVisible({ timeout: 120_000 });
    await expect(status).toContainText("Ready");

    await expect
      .poll(async () => await modal.locator("canvas:visible, video:visible").count(), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);

    await modal.getByRole("button", { name: /fullscreen browser session/i }).click();
    const fullscreenModal = page.getByTestId("browser-session-modal");
    await expect(fullscreenModal.getByTestId("browser-session-status")).toContainText("Ready", {
      timeout: 30_000,
    });
    await expect
      .poll(async () => await fullscreenModal.locator("canvas:visible, video:visible").count(), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  });

  test("drives viewport-only Shared Browser from the local chrome", async ({ page }) => {
    let releaseCapabilities = () => {};
    const capabilitiesGate = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    await page.route("**/browser/capabilities", async (route) => {
      await capabilitiesGate;
      await route.continue();
    });

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("instafy:browser-open", { detail: {} }));
    });

    const modal = page.getByTestId("browser-session-modal");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByTestId("browser-session-status")).toContainText("Ready", {
      timeout: 180_000,
    });

    await expect(modal.getByTestId("browser-session-stage")).toHaveAttribute(
      "data-shared-browser-viewer",
      /^(webrtc|cdp-screencast|rfb)$/,
    );

    const pixelSurface = modal.locator("canvas:visible, video:visible");
    await expect.poll(async () => await pixelSurface.count(), { timeout: 60_000 }).toBe(1);
    await pixelSurface.evaluate((element) => {
      element.setAttribute("data-shared-browser-pixel-surface-instance", "original");
    });

    releaseCapabilities();
    const localChrome = modal.getByTestId("shared-browser-chrome");
    await expect(localChrome).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("browser-session-page-strip")).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const [chromeBox, stageBox, composerBox] = await Promise.all([
            localChrome.boundingBox(),
            modal.getByTestId("browser-session-stage").boundingBox(),
            page.getByTestId("chat-composer-overlay").boundingBox(),
          ]);
          if (!chromeBox || !stageBox || !composerBox) {
            return null;
          }
          return {
            chromeFits: chromeBox.height <= 48,
            composerFits: composerBox.height <= 64,
            surfaceGap: Math.round(composerBox.y - (stageBox.y + stageBox.height)),
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ chromeFits: true, composerFits: true, surfaceGap: 0 });
    expect(
      await localChrome.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    const initialViewport = page.viewportSize() ?? { width: 1440, height: 900 };
    await page.setViewportSize({ width: 430, height: 900 });
    await expect
      .poll(async () => {
        const [chromeFits, composerBox, addressBox] = await Promise.all([
          localChrome.evaluate((element) => element.scrollWidth <= element.clientWidth),
          page.getByTestId("chat-composer-overlay").boundingBox(),
          localChrome.getByTestId("shared-browser-address").boundingBox(),
        ]);
        return {
          addressUsable: (addressBox?.width ?? 0) >= 96,
          chromeFits,
          composerFits: (composerBox?.height ?? Number.POSITIVE_INFINITY) <= 64,
        };
      })
      .toEqual({ addressUsable: true, chromeFits: true, composerFits: true });
    await page.setViewportSize(initialViewport);
    await expect(
      modal.locator('[data-shared-browser-pixel-surface-instance="original"]'),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const [stageBox, canvasBox] = await Promise.all([
            modal.getByTestId("browser-session-stage").boundingBox(),
            pixelSurface.boundingBox(),
          ]);
          return Boolean(
            stageBox &&
              canvasBox &&
              Math.abs(stageBox.width - canvasBox.width) <= 2 &&
              Math.abs(stageBox.height - canvasBox.height) <= 2,
          );
        },
        {
          timeout: 30_000,
          message: "the active pixel transport should resize to fill the local browser surface",
        },
      )
      .toBe(true);

    const address = localChrome.getByTestId("shared-browser-address");
    await address.fill("example.com");
    await address.press("Enter");
    await expect(address).toHaveValue("https://example.com/", { timeout: 30_000 });

    const back = localChrome.getByTestId("shared-browser-back");
    await expect(back).toBeEnabled({ timeout: 30_000 });
    await back.click();
    await expect(address).toHaveValue("about:blank", { timeout: 30_000 });

    const forward = localChrome.getByTestId("shared-browser-forward");
    await expect(forward).toBeEnabled({ timeout: 30_000 });
    await forward.click();
    await expect(address).toHaveValue("https://example.com/", { timeout: 30_000 });

    await localChrome.getByTestId("shared-browser-reload").click();
    await expect(
      modal.locator('[data-shared-browser-pixel-surface-instance="original"]'),
    ).toBeVisible();
  });

  test("reuses the same browser session across turns", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Project id missing for browser session smoke test.");
    }

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();

    const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
    const baselineAssistantCount = await assistantBubbles.count();

    await chatInput.fill("Open a browser session and go to https://example.com. Keep it visible inline.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("conversation-subtabs")).toBeVisible({ timeout: 300_000 });
    await page.getByTestId("conversation-subtab-chat").click();
    await expectAssistantReplyOrSkipRateLimit(page, /example\.com|Example Domain|browser session/i, {
      timeout: 300_000,
    });
    await page.getByTestId("conversation-subtab-browser").click();

    const modal = page.getByTestId("browser-session-modal");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByTestId("browser-session-status")).toContainText("Ready", {
      timeout: 120_000,
    });
    await expect
      .poll(async () => await modal.locator("canvas:visible, video:visible").count(), {
        timeout: 60_000,
      })
      .toBe(1);
    await modal.locator("canvas:visible, video:visible").evaluate((surface) => {
      surface.setAttribute("data-browser-pixel-surface-instance", "original");
    });

    await page.getByTestId("conversation-subtab-chat").click();
    await expect(modal).toBeHidden();
    await expect(modal).toHaveCount(1);

    await chatInput.fill("Read the page title from the existing browser session and reply with the title only.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expectAssistantReplyOrSkipRateLimit(page, /Example Domain/i, { timeout: 300_000 });

    await page.getByTestId("conversation-subtab-browser").click();
    await expect(
      modal.locator('[data-browser-pixel-surface-instance="original"]'),
    ).toBeVisible();

    await expect(assistantBubbles).toHaveCount(baselineAssistantCount + 2, { timeout: 120_000 });
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId("browser-session-status")).toContainText("Ready");
    await expect(page.getByTestId("browser-session-modal")).toHaveCount(1);
  });

  test("keeps the browser session visibly connected across responsive resize", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Project id missing for browser session smoke test.");
    }

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();
    await chatInput.fill("Open a browser session and go to https://example.com. Keep it visible inline.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("conversation-subtabs")).toBeVisible({ timeout: 300_000 });
    await page.getByTestId("conversation-subtab-chat").click();
    await expectAssistantReplyOrSkipRateLimit(page, /example\.com|Example Domain|browser session/i, {
      timeout: 300_000,
    });
    await page.getByTestId("conversation-subtab-browser").click();

    const modal = page.getByTestId("browser-session-modal");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByTestId("browser-session-status")).toContainText("Ready", {
      timeout: 120_000,
    });
    await expect
      .poll(async () => await modal.locator("canvas:visible, video:visible").count(), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);

    const samples = [
      ...(await sampleBrowserSessionRegionText(page, { width: 1440, height: 900 })),
      ...(await sampleBrowserSessionRegionText(page, { width: 430, height: 932 })),
      ...(await sampleBrowserSessionRegionText(page, { width: 1440, height: 900 })),
    ];

    for (const sample of samples) {
      expect(sample).toContain("Ready");
      expect(sample).not.toContain("Open fullscreen when ready.");
      expect(sample).not.toContain("Browser starting");
      expect(sample).not.toContain("Connecting…");
      expect(sample).not.toContain("Loading…");
    }
  });
});
