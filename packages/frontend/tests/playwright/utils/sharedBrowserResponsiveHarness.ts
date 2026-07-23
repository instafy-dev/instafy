import { expect, type Locator, type Page } from "@playwright/test";

import {
  remoteSurfaceHasRenderedFrame,
  remoteSurfaceScreenshotPaint,
} from "./electronBrowserLiveHarness.js";
import { sharedPixelSurface } from "./sharedBrowserCollaborationHarness.js";

export type SharedBrowserResponsiveGeometry = {
  addressWidth: number;
  composerHeight: number;
  panelWidth: number;
  stageHeight: number;
  stageWidth: number;
};

export type SharedBrowserContentBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

function visibleBrowserSurface(page: Page): Locator {
  return sharedPixelSurface(page);
}

/**
 * Resolve the page pixels inside a full-size media element. CDP/WebRTC use
 * object-fit containment, so the element box can include neutral gutters on
 * an asymmetric viewer. RFB canvases keep their existing full-box behavior.
 */
export async function sharedBrowserContentBox(
  page: Page,
): Promise<SharedBrowserContentBox> {
  return visibleBrowserSurface(page).evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement || element instanceof HTMLVideoElement)) {
      throw new Error("Shared Browser surface is not canvas or video.");
    }
    const bounds = element.getBoundingClientRect();
    const explicitWidth = Number(element.getAttribute("data-remote-content-width"));
    const explicitHeight = Number(element.getAttribute("data-remote-content-height"));
    const hasExplicitSize =
      Number.isFinite(explicitWidth) &&
      explicitWidth > 0 &&
      Number.isFinite(explicitHeight) &&
      explicitHeight > 0;
    const usesContainFit =
      hasExplicitSize ||
      element.classList.contains("object-contain") ||
      element.style.objectFit === "contain";
    if (!usesContainFit) {
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    const intrinsicWidth =
      element instanceof HTMLCanvasElement ? element.width : element.videoWidth;
    const intrinsicHeight =
      element instanceof HTMLCanvasElement ? element.height : element.videoHeight;
    // Test against the browser's actual decoded media dimensions first. This
    // intentionally does not mirror the product helper's metadata precedence:
    // a viewer-local socket message must never make cursor assertions agree
    // with metadata that disagrees with the painted pixels.
    const hasIntrinsicSize =
      Number.isFinite(intrinsicWidth) &&
      intrinsicWidth > 0 &&
      Number.isFinite(intrinsicHeight) &&
      intrinsicHeight > 0;
    const contentWidth = hasIntrinsicSize ? intrinsicWidth : explicitWidth;
    const contentHeight = hasIntrinsicSize ? intrinsicHeight : explicitHeight;
    if (
      bounds.width < 1 ||
      bounds.height < 1 ||
      !Number.isFinite(contentWidth) ||
      contentWidth < 1 ||
      !Number.isFinite(contentHeight) ||
      contentHeight < 1
    ) {
      throw new Error("Shared Browser content geometry is not ready.");
    }
    const scale = Math.min(bounds.width / contentWidth, bounds.height / contentHeight);
    const width = contentWidth * scale;
    const height = contentHeight * scale;
    return {
      x: bounds.x + (bounds.width - width) / 2,
      y: bounds.y + (bounds.height - height) / 2,
      width,
      height,
    };
  });
}

export async function hoverSharedSurfaceAtNormalizedPoint(
  page: Page,
  point: { x: number; y: number },
) {
  const surface = visibleBrowserSurface(page);
  const [surfaceBox, contentBox] = await Promise.all([
    surface.boundingBox(),
    sharedBrowserContentBox(page),
  ]);
  if (!surfaceBox) {
    throw new Error("Shared Browser pixel surface is unavailable for cursor placement.");
  }
  await surface.hover({
    force: true,
    position: {
      x:
        contentBox.x -
        surfaceBox.x +
        Math.min(Math.max(point.x, 0.001), 0.999) * contentBox.width,
      y:
        contentBox.y -
        surfaceBox.y +
        Math.min(Math.max(point.y, 0.001), 0.999) * contentBox.height,
    },
  });
}

export async function expectResponsiveSharedBrowserLayout(
  page: Page,
  options: {
    minAddressWidth?: number;
    minStageHeight?: number;
  } = {},
): Promise<SharedBrowserResponsiveGeometry> {
  const minAddressWidth = options.minAddressWidth ?? 96;
  const minStageHeight = options.minStageHeight ?? 96;
  const modal = page.getByTestId("browser-session-modal");
  const chrome = modal.getByTestId("shared-browser-chrome");
  const address = chrome.getByTestId("shared-browser-address");
  const stage = modal.getByTestId("browser-session-stage");
  const composer = page.getByTestId("chat-composer-overlay");

  await expect(modal).toBeVisible({ timeout: 60_000 });
  await expect(chrome).toBeVisible();
  await expect(address).toBeVisible();
  await expect(stage).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Browser session" })).toHaveCount(0);

  await expect
    .poll(
      async () =>
        page.evaluate(() => ({
          documentFits: document.documentElement.scrollWidth <= window.innerWidth + 1,
          bodyFits: document.body.scrollWidth <= window.innerWidth + 1,
        })),
      { timeout: 15_000 },
    )
    .toEqual({ bodyFits: true, documentFits: true });
  await expect
    .poll(async () => chrome.evaluate((element) => element.scrollWidth <= element.clientWidth), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect
    .poll(async () => composer.evaluate((element) => element.scrollWidth <= element.clientWidth), {
      timeout: 15_000,
    })
    .toBe(true);

  await expect
    .poll(
      async () => {
        const [modalBox, addressBox, stageBox, composerBox] = await Promise.all([
          modal.boundingBox(),
          address.boundingBox(),
          stage.boundingBox(),
          composer.boundingBox(),
        ]);
        if (!modalBox || !addressBox || !stageBox || !composerBox) {
          return null;
        }
        return {
          addressWidth: Math.round(addressBox.width),
          composerHeight: Math.round(composerBox.height),
          panelWidth: Math.round(modalBox.width),
          stageHeight: Math.round(stageBox.height),
          stageWidth: Math.round(stageBox.width),
          stageEndsAtComposer: Math.abs(stageBox.y + stageBox.height - composerBox.y) <= 2,
        };
      },
      { timeout: 30_000 },
    )
    .toMatchObject({
      addressWidth: expect.any(Number),
      composerHeight: expect.any(Number),
      panelWidth: expect.any(Number),
      stageEndsAtComposer: true,
      stageHeight: expect.any(Number),
      stageWidth: expect.any(Number),
    });

  // Playwright's poll matcher does not return its observed value. Read the same
  // stable geometry once more after the assertion above.
  const [modalBox, addressBox, stageBox, composerBox] = await Promise.all([
    modal.boundingBox(),
    address.boundingBox(),
    stage.boundingBox(),
    composer.boundingBox(),
  ]);
  if (!modalBox || !addressBox || !stageBox || !composerBox) {
    throw new Error("Shared Browser responsive geometry disappeared after settling.");
  }
  const settled: SharedBrowserResponsiveGeometry = {
    addressWidth: Math.round(addressBox.width),
    composerHeight: Math.round(composerBox.height),
    panelWidth: Math.round(modalBox.width),
    stageHeight: Math.round(stageBox.height),
    stageWidth: Math.round(stageBox.width),
  };
  expect(settled.addressWidth).toBeGreaterThanOrEqual(minAddressWidth);
  expect(settled.stageHeight).toBeGreaterThanOrEqual(minStageHeight);
  expect(settled.stageWidth).toBeGreaterThan(0);
  expect(settled.composerHeight).toBeLessThanOrEqual(72);

  const surface = visibleBrowserSurface(page);
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => remoteSurfaceHasRenderedFrame(surface), { timeout: 45_000 })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const [surfaceBox, currentStageBox] = await Promise.all([
          surface.boundingBox(),
          stage.boundingBox(),
        ]);
        if (!surfaceBox || !currentStageBox) {
          return false;
        }
        return (
          Math.abs(surfaceBox.x - currentStageBox.x) <= 2 &&
          Math.abs(surfaceBox.y - currentStageBox.y) <= 2 &&
          Math.abs(surfaceBox.width - currentStageBox.width) <= 2 &&
          Math.abs(surfaceBox.height - currentStageBox.height) <= 2
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const paint = await remoteSurfaceScreenshotPaint(surface);
  expect(paint.averageLuminance).toBeGreaterThan(12);
  expect(paint.darkPixelRatio).toBeLessThan(0.95);
  expect(paint.luminanceRange).toBeGreaterThan(10);
  return settled;
}

export async function expectParticipantPointerAtNormalizedPoint(
  page: Page,
  participantLabel: string,
  normalizedPoint: { x: number; y: number },
  tolerance = 12,
) {
  const root = page.getByTestId("shared-browser-participant-pointers");
  const pointer = page
    .getByTestId("shared-browser-participant-pointer")
    .filter({ hasText: participantLabel });
  await expect(pointer).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => {
      const [rootBox, contentBox, position] = await Promise.all([
        root.boundingBox(),
        sharedBrowserContentBox(page),
        pointer.evaluate((element) => ({
          left: Number.parseFloat((element as HTMLElement).style.left),
          top: Number.parseFloat((element as HTMLElement).style.top),
        })),
      ]);
      if (
        !rootBox ||
        !Number.isFinite(position.left) ||
        !Number.isFinite(position.top)
      ) {
        return null;
      }
      const expectedLeft = contentBox.x - rootBox.x + normalizedPoint.x * contentBox.width;
      const expectedTop = contentBox.y - rootBox.y + normalizedPoint.y * contentBox.height;
      return {
        leftWithinTolerance: Math.abs(position.left - expectedLeft) <= tolerance,
        topWithinTolerance: Math.abs(position.top - expectedTop) <= tolerance,
      };
    })
    .toEqual({
      leftWithinTolerance: true,
      topWithinTolerance: true,
    });
}
