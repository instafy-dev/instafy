import { expect, type Page } from "@playwright/test";

import { remoteSurfaceScreenshotPaint } from "../utils/electronBrowserLiveHarness.js";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  restoreAuthenticatedSession,
  waitForHostedRuntimeReady,
  waitForStoreProjectId,
} from "../utils/harness.js";
import { test } from "../utils/sharedBrowserProductionLifecycle.js";
import {
  disruptLatestBrowserTransportSockets,
  inputSocketProbeSnapshot,
  latestOpenInputSocket,
  openSharedBrowser,
  sharedPixelSurface,
  waitForOpenInputSocket,
} from "../utils/sharedBrowserCollaborationHarness.js";
import { expectResponsiveSharedBrowserLayout } from "../utils/sharedBrowserResponsiveHarness.js";

const ENABLED =
  (process.env.PLAYWRIGHT_SHARED_BROWSER_RESPONSIVE ?? "").trim() === "1";

const VIEWPORTS = [
  { name: "phone-360x800", width: 360, height: 800 },
  { name: "phone-390x844", width: 390, height: 844 },
  { name: "phone-landscape-844x390", width: 844, height: 390 },
  { name: "tablet-portrait-768x1024", width: 768, height: 1024 },
  { name: "tablet-landscape-1024x768", width: 1024, height: 768 },
] as const;

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000)
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => undefined);
  }
  await waitForHostedRuntimeReady(page, 180_000, { projectId });
}

async function keepResponsiveProofOnCdp(page: Page) {
  await page.route("**/browser/capabilities", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const viewerKinds = Array.isArray(payload.viewerKinds)
      ? payload.viewerKinds.filter((viewer) => viewer === "cdp-screencast")
      : [];
    await route.fulfill({
      response,
      json: {
        ...payload,
        preferredViewer: "cdp-screencast",
        viewerKinds,
        rfb: null,
        webrtc: null,
      },
    });
  });
}

async function expectPhoneTransportRecovery(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  expectedPageId: string,
) {
  const modal = page.getByTestId("browser-session-modal");
  const disruption = await disruptLatestBrowserTransportSockets(page);
  expect(disruption.pageId).toBe(expectedPageId);

  const reconnecting = modal.getByTestId("browser-session-reconnecting");
  const frozenFrame = modal.getByTestId("browser-session-frozen-frame");
  await expect(reconnecting).toBeVisible({ timeout: 3_000 });
  await expect(frozenFrame).toBeVisible({ timeout: 3_000 });
  const frozenScreenshotPath = testInfo.outputPath(
    "shared-browser-phone-390x844-interrupted.png",
  );
  const frozenScreenshot = await frozenFrame.screenshot({
    animations: "disabled",
    path: frozenScreenshotPath,
  });
  const frozenPaint = await remoteSurfaceScreenshotPaint(frozenFrame, frozenScreenshot);
  expect(frozenPaint.averageLuminance).toBeGreaterThan(12);
  expect(frozenPaint.darkPixelRatio).toBeLessThan(0.95);
  expect(frozenPaint.luminanceRange).toBeGreaterThan(10);
  await testInfo.attach("Shared Browser phone interrupted frozen frame", {
    contentType: "image/png",
    path: frozenScreenshotPath,
  });

  await waitForOpenInputSocket(page);
  await expect
    .poll(async () => {
      const entries = await inputSocketProbeSnapshot(page);
      const current = await latestOpenInputSocket(page);
      return (
        entries.length > disruption.inputEntryCount &&
        current?.pageId === expectedPageId
      );
    }, { timeout: 60_000 })
    .toBe(true);
  await expect(reconnecting).toBeHidden({ timeout: 60_000 });
  await expect(frozenFrame).toHaveCount(0, { timeout: 60_000 });
  await expect(modal.getByTestId("browser-session-status")).toContainText("Ready");
}

test.describe("Shared Browser responsive continuity", () => {
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_SHARED_BROWSER_RESPONSIVE=1 for the live responsive browser proof.",
  );
  test.setTimeout(600_000);

  let activeProjectId: string | null = null;

  test.afterEach(async ({ page, sharedBrowserProductionLifecycle }) => {
    if (sharedBrowserProductionLifecycle.enabled) {
      return;
    }
    await resetRuntimeUserState(page, {
      projectIds: [activeProjectId],
      source: "browser-session-responsive:cleanup",
    }).catch(() => undefined);
    activeProjectId = null;
  });

  test("keeps one painted Shared Browser usable across phone, landscape, and tablet widths", async ({
    page,
    sharedBrowserProductionLifecycle,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const owner = sharedBrowserProductionLifecycle.enabled
      ? await sharedBrowserProductionLifecycle.provisionOwner()
      : null;
    const projectId = owner
      ? owner.projectId
      : await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for Shared Browser responsive proof.");
    }
    if (owner) {
      await restoreAuthenticatedSession(page, owner.session, {
        landingPath: `/studio?projectId=${encodeURIComponent(projectId)}`,
      });
      expect(await waitForStoreProjectId(page, projectId, 30_000)).toBe(true);
    } else {
      activeProjectId = projectId;
    }
    await clearRuntimePreference(page, {
      projectId,
      source: "browser-session-responsive",
    });
    await ensureHostedRuntimeReady(page, projectId);
    await keepResponsiveProofOnCdp(page);

    const binding = await openSharedBrowser(page, { constrainForCdp: false });
    await waitForOpenInputSocket(page);
    const initialInput = await latestOpenInputSocket(page);
    if (!initialInput?.pageId) {
      throw new Error("Responsive Shared Browser input socket omitted its page id.");
    }
    const modal = page.getByTestId("browser-session-modal");
    await modal.evaluate((element) => {
      element.setAttribute("data-responsive-session-instance", "original");
    });
    const address = modal.getByTestId("shared-browser-address");
    await expect(address).toBeEnabled({ timeout: 60_000 });
    await address.fill("https://example.com");
    await address.press("Enter");
    await expect(address).toHaveValue("https://example.com/", { timeout: 60_000 });
    expect(binding.runtimeId).toBeTruthy();
    expect(binding.originId).toBeTruthy();
    expect(binding.browserSessionId).toBeTruthy();

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const minStageHeight = Math.max(96, Math.floor(viewport.height * 0.24));
      await expectResponsiveSharedBrowserLayout(page, { minStageHeight });
      await expect(
        page.locator('[data-responsive-session-instance="original"]'),
      ).toBeVisible();
      await expect(page.getByTestId("browser-session-modal")).toHaveCount(1);
      await expect(address).toHaveValue("https://example.com/");
      await expect(page.getByTestId("conversation-subtab-browser")).toHaveAttribute(
        "aria-selected",
        "true",
      );

      const screenshotPath = testInfo.outputPath(`shared-browser-${viewport.name}.png`);
      const screenshot = await sharedPixelSurface(page).screenshot({
        animations: "disabled",
        path: screenshotPath,
      });
      const paint = await remoteSurfaceScreenshotPaint(sharedPixelSurface(page), screenshot);
      expect(paint.darkPixelRatio).toBeLessThan(0.95);
      expect(paint.luminanceRange).toBeGreaterThan(10);
      await testInfo.attach(`Shared Browser ${viewport.name}`, {
        contentType: "image/png",
        path: screenshotPath,
      });

      if (viewport.name === "phone-390x844") {
        await expectPhoneTransportRecovery(page, testInfo, initialInput.pageId);
        await expectResponsiveSharedBrowserLayout(page, { minStageHeight });
        await expect(
          page.locator('[data-responsive-session-instance="original"]'),
        ).toBeVisible();
        await expect(address).toHaveValue("https://example.com/");
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await expectResponsiveSharedBrowserLayout(page, { minStageHeight: 180 });
    await expect(page.locator('[data-responsive-session-instance="original"]')).toBeVisible();
    await expect(address).toHaveValue("https://example.com/");
  });
});
