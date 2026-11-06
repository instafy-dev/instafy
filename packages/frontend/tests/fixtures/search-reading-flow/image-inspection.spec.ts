import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const before = process.env.INSTAFY_REVIEW_VERSION === "before";
const artifactDir = process.env.INSTAFY_REVIEW_ARTIFACT_DIR;
const image = (page: Page) => page.getByTestId("chat-image-lightbox-image");
const stage = (page: Page) => page.getByTestId("chat-image-lightbox-stage");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Image preview" });
const close = (page: Page) => page.getByTestId("chat-image-lightbox-close");
const draft = "Keep the detail review here while inspecting the original image.";

async function capture(page: Page, name: string) {
  if (!artifactDir) return;
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, `${before ? "before" : "after"}-inspection-${name}.png`) });
}

async function openReference(page: Page, theme: string, shape: string, touch: boolean) {
  await page.goto(`/tests/fixtures/search-reading-flow/index.html?theme=${theme}&review=image&imageShape=design-${shape}`);
  await page.getByTestId("studio-search-input").fill("navigation");
  await page.getByTestId("studio-search-result-message-original").click();
  await page.getByTestId("chat-input").fill(draft);
  const opener = page.getByTestId("chat-image-attachment-thumbnail");
  if (touch) await opener.tap(); else await opener.click();
  await expect(image(page)).toBeVisible();
  await expect.poll(() => image(page).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  return opener;
}

async function insideViewport(page: Page, locator: Locator) {
  const bounds = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function visibleImageCenter(page: Page) {
  const bounds = (await image(page).boundingBox())!;
  const viewport = page.viewportSize()!;
  return {
    x: (Math.max(0, bounds.x) + Math.min(viewport.width, bounds.x + bounds.width)) / 2,
    y: (Math.max(85, bounds.y) + Math.min(viewport.height - 85, bounds.y + bounds.height)) / 2,
  };
}

/** Real browser touch input; no dispatchEvent shortcut or page-scale emulation. */
async function touchPinch(page: Page, factor: number) {
  const center = await visibleImageCenter(page);
  const initialDistance = 48;
  const session = await page.context().newCDPSession(page);
  const points = (progress: number) => {
    const half = initialDistance * (1 + (factor - 1) * progress) / 2;
    return [-1, 1].map((direction, index) => ({ id: index + 1, x: center.x + half * direction, y: center.y, radiusX: 2, radiusY: 2, force: 1 }));
  };
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
    for (const progress of [.2, .4, .6, .8, 1]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(progress) });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}

async function touchPan(page: Page, dx: number, dy: number) {
  const center = await visibleImageCenter(page);
  const session = await page.context().newCDPSession(page);
  const point = (progress: number) => [{ id: 1, x: center.x + dx * progress, y: center.y + dy * progress, radiusX: 2, radiusY: 2, force: 1 }];
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
    for (const progress of [.2, .4, .6, .8, 1]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(progress) });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}

async function doubleTapImage(page: Page) {
  const point = await visibleImageCenter(page);
  await page.touchscreen.tap(point.x, point.y);
  await page.touchscreen.tap(point.x, point.y);
}

async function tapImage(page: Page) {
  const point = await visibleImageCenter(page);
  await page.touchscreen.tap(point.x, point.y);
}

async function revealImageControls(page: Page) {
  const controls = page.getByTestId("chat-image-controls");
  if (await controls.count() && await controls.getAttribute("data-visible") === "false") {
    await tapImage(page);
    await expect(controls).toHaveAttribute("data-visible", "true");
  }
}

async function assertReturnedToMessage(page: Page, opener: Locator) {
  await close(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByTestId("chat-input")).toHaveText(draft);
  await expect(page.getByTestId("chat-input")).not.toBeFocused();
  await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", "older-navigation-notes");
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 390]) {
    for (const shape of ["tall", "wide"]) {
      test.describe(`image inspection ${theme} ${width} ${shape}`, () => {
        test.use({ viewport: { width, height: 760 }, hasTouch: true });
        test("inspects original image pixels without changing page zoom or losing the message", async ({ page }) => {
          const opener = await openReference(page, theme, shape, true);
          const fitted = (await image(page).boundingBox())!;
          await insideViewport(page, close(page));
          await capture(page, `${theme}-${width}-${shape}-fit`);
          if (!before) {
            await touchPinch(page, 2.5);
            await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(fitted.width * 1.8);
            expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
            await expect(dialog(page)).toBeVisible();
            await insideViewport(page, close(page));
            await capture(page, `${theme}-${width}-${shape}-pinch`);
            await revealImageControls(page);
            await page.getByRole("button", { name: "Fit image", exact: true }).click();
            await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
            await doubleTapImage(page);
            await expect(stage(page)).toHaveAttribute("data-mode", "width");
            const doubleTapped = (await image(page).boundingBox())!;
            const canvas = (await stage(page).boundingBox())!;
            expect(doubleTapped.width).toBeCloseTo(canvas.width, 0);
            if (shape === "tall") expect(doubleTapped.y).toBeCloseTo(canvas.y, 0);
            await page.getByRole("button", { name: "Fit width", exact: true }).click();
            expect(await image(page).boundingBox()).toEqual(doubleTapped);
            await doubleTapImage(page);
            await expect(stage(page)).toHaveAttribute("data-mode", "overview");
            await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
            if (shape === "tall") {
              await page.getByRole("button", { name: "Fit width", exact: true }).click();
              const fitWidth = (await image(page).boundingBox())!;
              expect(fitWidth.width).toBeGreaterThan(width * .8);
              expect(fitWidth.height).toBeGreaterThan(760);
              await touchPan(page, 0, -170);
              await expect.poll(async () => (await image(page).boundingBox())!.y).toBeLessThan(fitWidth.y - 100);
              await touchPan(page, 0, 160);
              await expect(dialog(page)).toBeVisible();
              await insideViewport(page, close(page));
              await capture(page, `${theme}-${width}-${shape}-width`);
            }
          }
          await assertReturnedToMessage(page, opener);
        });
      });
    }
  }
}

for (const theme of ["light", "dark"]) {
  test.describe(`desktop image inspection ${theme}`, () => {
    test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false });
    test("offers keyboard zoom, actual pixels, wheel inspection and a recoverable fit", async ({ page }) => {
      const opener = await openReference(page, theme, "wide", false);
      const fitted = (await image(page).boundingBox())!;
      await capture(page, `${theme}-1280-wide-fit`);
      if (!before) {
        const canvas = page.getByRole("region", { name: "Image inspection" });
        const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
        const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
        await zoomIn.focus();
        await page.keyboard.press("Enter");
        await expect(zoomIn).toBeFocused();
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(fitted.width);
        await zoomOut.focus();
        await page.keyboard.press("Enter");
        await expect(zoomOut).toBeFocused();
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
        await page.getByRole("button", { name: "Actual size (100%)", exact: true }).click();
        const naturalWidth = await image(page).evaluate(element => (element as HTMLImageElement).naturalWidth);
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(naturalWidth, 0);
        await capture(page, `${theme}-1280-wide-actual`);
        await canvas.focus();
        const startX = (await image(page).boundingBox())!.x;
        await page.keyboard.press("ArrowLeft");
        await expect.poll(async () => (await image(page).boundingBox())!.x).not.toBe(startX);
        const beforeWheelY = (await image(page).boundingBox())!.y;
        const wheelPoint = await visibleImageCenter(page);
        await page.mouse.move(wheelPoint.x, wheelPoint.y);
        await page.mouse.wheel(0, 100);
        await expect.poll(async () => (await image(page).boundingBox())!.y).toBeLessThan(beforeWheelY);
        await page.keyboard.press("0");
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
        await page.keyboard.press("+");
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(fitted.width);
        await page.keyboard.press("-");
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
        await page.keyboard.press("1");
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(naturalWidth, 0);
        await page.keyboard.press("0");
        const center = await visibleImageCenter(page);
        await page.mouse.move(center.x, center.y);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -200);
        await page.keyboard.up("Control");
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(fitted.width);
        expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
        await insideViewport(page, close(page));
        await insideViewport(page, zoomIn);
        await insideViewport(page, zoomOut);
        await page.getByRole("button", { name: "Fit image", exact: true }).click();
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
        for (let count = 0; count < 20 && await zoomIn.getAttribute("aria-disabled") !== "true"; count++) await zoomIn.press("Enter");
        await expect(zoomIn).toHaveAttribute("aria-disabled", "true");
        await expect(zoomIn).toBeFocused();
        const maximum = (await image(page).boundingBox())!.width;
        await zoomIn.press("Enter");
        expect((await image(page).boundingBox())!.width).toBeCloseTo(maximum, 0);
        for (let count = 0; count < 20 && await zoomOut.getAttribute("aria-disabled") !== "true"; count++) await zoomOut.press("Enter");
        await expect(zoomOut).toHaveAttribute("aria-disabled", "true");
        await expect(zoomOut).toBeFocused();
        await zoomOut.press("Enter");
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(fitted.width, 0);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await assertReturnedToMessage(page, opener);
    });
  });

  for (const shape of ["tall", "wide"]) {
    test.describe(`image inspection rotation ${theme} ${shape}`, () => {
      test.use({ viewport: { width: 390, height: 760 }, hasTouch: true });
      test("retains the inspected source position while moving controls into the landscape safe area", async ({ page }) => {
        await page.addInitScript(() => addEventListener("DOMContentLoaded", () => {
          for (const [side, value] of Object.entries({ top: 24, right: 32, bottom: 18, left: 24 })) document.documentElement.style.setProperty(`--instafy-safe-area-inset-${side}`, `${value}px`);
        }));
        const opener = await openReference(page, theme, shape, true);
        if (before) {
          await page.setViewportSize({ width: 844, height: 390 });
          await insideViewport(page, close(page));
          await capture(page, `${theme}-844-${shape}-rotated`);
          await assertReturnedToMessage(page, opener);
          return;
        }
        if (shape === "tall") {
          await revealImageControls(page);
          await page.getByRole("button", { name: "Fit width", exact: true }).click();
          await touchPan(page, 0, -170);
          await touchPan(page, 0, -170);
        } else {
          await touchPinch(page, 3);
          await touchPan(page, -50, 0);
        }
        const sourcePoint = async () => {
          const bounds = (await image(page).boundingBox())!;
          const canvas = (await stage(page).boundingBox())!;
          return { x: (canvas.x + canvas.width / 2 - bounds.x) / bounds.width, y: (canvas.y + canvas.height / 2 - bounds.y) / bounds.height };
        };
        const previous = await sourcePoint();
        await capture(page, `${theme}-390-${shape}-before-rotation`);
        await page.setViewportSize({ width: 844, height: 390 });
        await expect(stage(page)).toHaveAttribute("data-immersive", "true");
        // These centered cases have room to preserve the anchor without edge
        // clamping. Measure drift in rendered pixels, not a loose image fraction.
        await expect.poll(async () => Math.abs((await sourcePoint()).x - previous.x) * (await image(page).boundingBox())!.width).toBeLessThan(2);
        await expect.poll(async () => Math.abs((await sourcePoint()).y - previous.y) * (await image(page).boundingBox())!.height).toBeLessThan(2);
        await insideViewport(page, close(page));
        for (const name of ["Zoom in", "Zoom out", "Fit image", "Fit width"]) await insideViewport(page, page.getByRole("button", { name, exact: true }));
        const closeRect = (await close(page).boundingBox())!;
        expect(closeRect.y).toBeGreaterThanOrEqual(24);
        expect(closeRect.x + closeRect.width).toBeLessThanOrEqual(844 - 32);
        await capture(page, `${theme}-844-${shape}-rotated`);
        await assertReturnedToMessage(page, opener);
      });
    });
  }
}

for (const theme of ["light", "dark"]) {
  test.describe(`image inspection residual touch ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 760 }, hasTouch: true });
    test("continues a pinch with one finger without jumping or dismissing the image", async ({ page }) => {
      test.skip(before, "Image-local pinch and pan are new");
      const opener = await openReference(page, theme, "wide", true);
      const center = await visibleImageCenter(page);
      const initialWidth = (await image(page).boundingBox())!.width;
      const session = await page.context().newCDPSession(page);
      const point = (id: number, x: number) => ({ id, x, y: center.y, radiusX: 2, radiusY: 2, force: 1 });
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(1, center.x - 24), point(2, center.x + 24)] });
        for (const half of [36, 48, 60, 72]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(1, center.x - half), point(2, center.x + half)] });
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(initialWidth * 3, 0);
        const pinched = (await image(page).boundingBox())!;
        // CDP touchEnd lists the contact being released, not the remaining one.
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [point(2, center.x + 72)] });
        const released = (await image(page).boundingBox())!;
        expect(Math.abs(released.x - pinched.x)).toBeLessThan(2);
        expect(Math.abs(released.y - pinched.y)).toBeLessThan(2);
        for (const amount of [15, 30, 45, 60]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(1, center.x - 72 - amount)] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(dialog(page)).toBeVisible();
        await expect.poll(async () => (await image(page).boundingBox())!.x).toBeCloseTo(released.x - 60, 0);
        await expect.poll(async () => (await image(page).boundingBox())!.width).toBeCloseTo(pinched.width, 0);
        expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
      } finally { await session.detach(); }
      await assertReturnedToMessage(page, opener);
    });
  });
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 390]) {
    for (const shape of ["tall", "wide"]) {
      test.describe(`mobile image controls ${theme} ${width} ${shape}`, () => {
        test.use({ viewport: { width, height: 760 }, hasTouch: true });
        test("toggles only for image taps and preserves controls through gestures, keyboard access and rotation", async ({ page }) => {
          const opener = await openReference(page, theme, shape, true);
          const controls = page.getByTestId("chat-image-controls");
          const fitted = (await image(page).boundingBox())!;
          await insideViewport(page, close(page));
          if (!before) {
            await expect(controls).toHaveAttribute("data-visible", "false");
            await expect(controls).toHaveCSS("opacity", "0");
          }
          await capture(page, `controls-${theme}-${width}-${shape}-default`);
          if (before) {
            await capture(page, `controls-${theme}-${width}-${shape}-visible`);
            await page.setViewportSize({ width: 844, height: 390 });
            await insideViewport(page, close(page));
            await capture(page, `controls-${theme}-${width}-${shape}-landscape`);
            await assertReturnedToMessage(page, opener);
            return;
          }
          // The first gesture starts while modal focus is still on Close;
          // moving focus into the canvas must not reveal tools for touch input.
          await touchPinch(page, 1.8);
          await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(fitted.width * 1.4);
          await page.waitForTimeout(350);
          await expect(controls).toHaveAttribute("data-visible", "false");
          await doubleTapImage(page);
          await expect(stage(page)).toHaveAttribute("data-mode", "overview");
          await page.waitForTimeout(350);
          await expect(controls).toHaveAttribute("data-visible", "false");
          await tapImage(page);
          await expect(controls).toHaveAttribute("data-visible", "true");
          await expect(controls).toHaveCSS("opacity", "1");
          const revealed = (await image(page).boundingBox())!;
          expect(revealed).toEqual(fitted);
          await capture(page, `controls-${theme}-${width}-${shape}-visible`);
          await tapImage(page);
          await expect(controls).toHaveAttribute("data-visible", "false");

          for (const visible of [false, true]) {
            if (visible) {
              await tapImage(page);
              await expect(controls).toHaveAttribute("data-visible", "true");
            }
            await doubleTapImage(page);
            await expect(stage(page)).toHaveAttribute("data-mode", "width");
            await page.waitForTimeout(350);
            await expect(controls).toHaveAttribute("data-visible", String(visible));
            await doubleTapImage(page);
            await expect(stage(page)).toHaveAttribute("data-mode", "overview");
            await page.waitForTimeout(350);
            await expect(controls).toHaveAttribute("data-visible", String(visible));
            const priorWidth = (await image(page).boundingBox())!.width;
            await touchPinch(page, 1.8);
            await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(priorWidth * 1.4);
            await doubleTapImage(page);
            await expect(stage(page)).toHaveAttribute("data-mode", "overview");
            await touchPinch(page, 1.8);
            await expect.poll(async () => (await image(page).boundingBox())!.width).toBeGreaterThan(fitted.width * 1.4);
            const priorPan = (await image(page).boundingBox())!;
            await touchPan(page, shape === "wide" ? -40 : 0, shape === "tall" ? -60 : 0);
            await expect.poll(async () => {
              const now = (await image(page).boundingBox())!;
              return shape === "wide" ? priorPan.x - now.x : priorPan.y - now.y;
            }).toBeGreaterThan(20);
            // A gesture must not leave a delayed single-tap toggle behind.
            await page.waitForTimeout(350);
            await expect(controls).toHaveAttribute("data-visible", String(visible));
            await expect(dialog(page)).toBeVisible();
            await insideViewport(page, close(page));
            await doubleTapImage(page);
            await expect(stage(page)).toHaveAttribute("data-mode", "overview");
          }
          // A toolbar action must not leave touch focus preventing the next
          // image tap from hiding it; keep the rotation comparison fitted.
          await page.getByRole("button", { name: "Fit image", exact: true }).click();
          await expect(stage(page)).toHaveAttribute("data-mode", "overview");
          await tapImage(page);
          await expect(controls).toHaveAttribute("data-visible", "false");
          await page.setViewportSize({ width: 844, height: 390 });
          await expect(controls).toHaveAttribute("data-visible", "false");
          await insideViewport(page, close(page));
          await capture(page, `controls-${theme}-${width}-${shape}-landscape`);

          // Hidden controls remain reachable to keyboard users; focus reveals
          // the same toolbar without requiring a pointer action first.
          await close(page).focus();
          await page.keyboard.press("Tab");
          await expect(page.getByRole("region", { name: "Image inspection" })).toBeFocused();
          await expect(controls).toHaveAttribute("data-visible", "true");
          await page.keyboard.press("Space");
          await expect(controls).toHaveAttribute("data-visible", "false");
          await page.keyboard.press("Space");
          await expect(controls).toHaveAttribute("data-visible", "true");
          await page.keyboard.press("Enter");
          await expect(controls).toHaveAttribute("data-visible", "false");
          await page.keyboard.press("Tab");
          await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeFocused();
          await expect(controls).toHaveAttribute("data-visible", "true");
          for (const name of ["Zoom out", "Zoom in", "Actual size (100%)", "Fit image", "Fit width"]) await insideViewport(page, page.getByRole("button", { name, exact: true }));
          await assertReturnedToMessage(page, opener);
        });
      });
    }
  }
  test.describe(`desktop image controls ${theme}`, () => {
    test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false });
    test("keeps the desktop toolbar visible while inspecting and clicking the image", async ({ page }) => {
      const opener = await openReference(page, theme, "wide", false);
      const controls = page.getByRole("group", { name: "Image zoom controls" });
      await expect(controls).toBeVisible();
      await capture(page, `controls-${theme}-1280-wide-default`);
      const point = await visibleImageCenter(page);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(550);
      await expect(controls).toBeVisible();
      if (!before) await expect(page.getByTestId("chat-image-controls")).toHaveAttribute("data-visible", "true");
      await insideViewport(page, close(page));
      await assertReturnedToMessage(page, opener);
    });
  });
}
