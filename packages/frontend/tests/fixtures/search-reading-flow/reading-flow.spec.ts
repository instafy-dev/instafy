import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const before = process.env.INSTAFY_REVIEW_VERSION === "before";
const artifactDir = process.env.INSTAFY_REVIEW_ARTIFACT_DIR;
const target = "older-navigation-notes";

async function capture(page: Page, label: string) {
  if (!artifactDir) return;
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, `${before ? "before" : "after"}-${label}.png`) });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scroll = page.getByTestId("chat-message-scroll");
  if (await scroll.count()) expect(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function insideViewport(page: Page, locator: Locator) {
  const rect = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function openOlderMessage(page: Page, theme: string, extra = "") {
  await page.goto(`/tests/fixtures/search-reading-flow/index.html?theme=${theme}${extra}`);
  const input = page.getByTestId("studio-search-input");
  await expect(input).toBeVisible();
  await input.fill("navigation");
  await expect(page.getByTestId("studio-search-result-message-original")).toBeVisible();
  await input.press("ArrowDown");
  await expect(page.getByTestId("studio-search-result-message-original")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", target);
  await expect(page.getByTestId("chat-image-attachment-thumbnail")).toBeVisible();
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 390, 768, 1280]) {
    test.describe(`${theme} ${width}px reading flow`, () => {
      test.use({ viewport: { width, height: width < 900 ? 760 : 900 }, hasTouch: width < 900 });
      test("searches, reads an old attachment, restores results, and returns to latest", async ({ page }) => {
        const errors: string[] = [];
        const remoteRequests: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => { if (/^https?:/.test(request.url()) && !["127.0.0.1", "localhost"].includes(new URL(request.url()).hostname)) remoteRequests.push(request.url()); });
        await page.goto(`/tests/fixtures/search-reading-flow/index.html?theme=${theme}`);
        const input = page.getByTestId("studio-search-input");
        await input.fill("navigation");
        await expect(page.getByTestId("studio-search-result-message-original")).toBeVisible();
        await capture(page, `${theme}-${width}-search`);
        await noHorizontalOverflow(page);
        await input.press("ArrowDown");
        await expect(page.getByTestId("studio-search-result-message-original")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", target);
        const scroll = page.getByTestId("chat-message-scroll");
        const image = page.getByTestId("chat-image-attachment-thumbnail");
        await expect(image).toBeVisible();
        await capture(page, `${theme}-${width}-older-message`);
        const editedDraft = "Keep these project links; compare the updated header next.";
        await page.getByTestId("chat-input").fill(editedDraft);
        const position = await scroll.evaluate(element => element.scrollTop);
        await image.click();
        const lightbox = page.getByTestId("chat-image-lightbox");
        await expect(lightbox).toBeVisible();
        if (!before) {
          await expect.poll(() => page.getByRole("dialog", { name: "Image preview" }).evaluate(element => element.contains(document.activeElement))).toBe(true);
          for (let index = 0; index < 2; index++) {
            await page.keyboard.press("Tab");
            await expect.poll(() => page.getByRole("dialog", { name: "Image preview" }).evaluate(element => element.contains(document.activeElement))).toBe(true);
          }
        }
        await capture(page, `${theme}-${width}-image`);
        await insideViewport(page, page.getByTestId("chat-image-lightbox-close"));
        if (before) await page.getByTestId("chat-image-lightbox-close").click();
        else {
          await page.keyboard.press("Escape");
          await expect(image).toBeFocused();
        }
        await expect(lightbox).toHaveCount(0);
        expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - position)).toBeLessThanOrEqual(2);
        if (!before) {
          const file = page.getByTestId("chat-file-attachment");
          await file.click();
          const preview = page.getByRole("dialog", { name: "navigation-review-notes-for-the-autumn-website-refresh.md" });
          await expect(preview).toBeVisible();
          await expect(page.getByTestId("chat-file-attachment-content")).toBeVisible();
          await capture(page, `${theme}-${width}-file`);
          await noHorizontalOverflow(page);
          await page.keyboard.press("Escape");
          await expect(preview).toHaveCount(0);
          await expect(file).toBeFocused();
          expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - position)).toBeLessThanOrEqual(2);
        }
        await expect(page.getByTestId("chat-input")).toHaveText(editedDraft);
        await page.getByRole("button", { name: "Back to results" }).click();
        await expect(input).toHaveValue("navigation");
        const result = page.getByTestId("studio-search-result-message-original");
        await expect(result).toBeFocused();
        await result.press("Enter");
        await expect(image).toBeVisible();
        // This host keeps a draft only while its conversation stays mounted.
        // Prove an actual edit survives the attachment/latest transition.
        await page.getByTestId("chat-input").fill(editedDraft);
        await image.click();
        await expect(lightbox).toBeVisible();
        if (before) await page.getByTestId("chat-image-lightbox-close").click();
        else await page.keyboard.press("Escape");
        if (before) await page.getByTestId("chat-message-return-latest").click();
        else {
          const latest = page.getByTestId("chat-new-messages");
          await insideViewport(page, latest);
          await latest.click();
        }
        await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", "");
        await expect(page).not.toHaveURL(/messageId=/);
        if (!before) await expect(scroll).toBeFocused();
        await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3);
        await expect(page.getByTestId("chat-input")).toHaveText(editedDraft);
        await expect(page.getByTestId("composer-draft")).toHaveText(editedDraft);
        await capture(page, `${theme}-${width}-latest`);
        await noHorizontalOverflow(page);
        await page.getByRole("button", { name: "Back to results" }).click();
        await expect(input).toHaveValue("navigation");
        await expect(result).toBeFocused();
        expect(errors).toEqual([]);
        expect(remoteRequests).toEqual([]);
      });
    });
  }
}

test.describe("history intent and short viewport", () => {
  test.use({ viewport: { width: 390, height: 438 }, hasTouch: true });
  test("does not load newer messages from target reveal, resize or layout scroll", async ({ page }) => {
    await openOlderMessage(page, "dark");
    const pane = page.getByTestId("review-chat-pane");
    const scroll = page.getByTestId("chat-message-scroll");
    await expect(pane).toHaveAttribute("data-history-pages", "0");
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.setViewportSize({ width: 390, height: 520 });
    await expect(pane).toHaveAttribute("data-history-pages", "0");
    await scroll.dispatchEvent("wheel", { deltaY: 120, deltaX: 0 });
    await expect(pane).toHaveAttribute("data-history-pages", "1");
    await expect(pane).toHaveAttribute("data-message-target", target);
    await noHorizontalOverflow(page);
  });

  test("requires fresh downward input after the final history page before leaving the target", async ({ page }) => {
    await openOlderMessage(page, "light");
    const pane = page.getByTestId("review-chat-pane");
    const scroll = page.getByTestId("chat-message-scroll");
    for (let expectedPage = 1; expectedPage <= 3; expectedPage++) {
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await scroll.dispatchEvent("wheel", { deltaY: 120, deltaX: 0 });
      await expect(pane).toHaveAttribute("data-history-pages", String(expectedPage));
      await expect(pane).toHaveAttribute("data-message-target", target);
    }
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(pane).toHaveAttribute("data-message-target", target);
    await scroll.dispatchEvent("wheel", { deltaY: 120, deltaX: 0 });
    await expect(pane).toHaveAttribute("data-message-target", "");
    await page.getByRole("button", { name: "Back to results" }).click();
    await expect(page.getByTestId("studio-search-input")).toHaveValue("navigation");
  });

  test("restores a scrolled result and its broadened search scope", async ({ page }) => {
    await page.goto("/tests/fixtures/search-reading-flow/index.html?theme=dark");
    await page.getByTestId("studio-search-input").fill("navigation");
    await page.getByRole("combobox", { name: "Search scope" }).selectOption("org");
    const result = page.getByTestId("studio-search-result-message-followup-10");
    await result.scrollIntoViewIfNeeded();
    await result.focus();
    const results = page.getByTestId("studio-search-results");
    const position = await results.evaluate(element => element.scrollTop);
    expect(position).toBeGreaterThan(0);
    await result.press("Enter");
    await page.getByRole("button", { name: "Back to results" }).click();
    await expect(result).toBeFocused();
    await expect(page.getByRole("combobox", { name: "Search scope" })).toHaveValue("org");
    expect(Math.abs(await results.evaluate(element => element.scrollTop) - position)).toBeLessThanOrEqual(2);
  });

  test("keeps latest reachable during newer-history loading and retry", async ({ page }) => {
    test.skip(before, "The fixed latest action is new");
    await openOlderMessage(page, "dark", "&history=retry");
    const scroll = page.getByTestId("chat-message-scroll");
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await scroll.dispatchEvent("wheel", { deltaY: 120, deltaX: 0 });
    await expect(scroll.getByRole("status")).toBeVisible();
    await insideViewport(page, page.getByTestId("chat-new-messages"));
    await expect(scroll.getByRole("alert")).toBeVisible();
    await insideViewport(page, page.getByTestId("chat-new-messages"));
    await page.getByTestId("chat-message-load-newer").click();
    await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-history-pages", "1");
    await expect(scroll.getByRole("alert")).toHaveCount(0);
    await page.getByTestId("chat-new-messages").click();
    await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", "");
    await expect(scroll).toBeFocused();
  });
});

test.describe("attachment recovery", () => {
  test.use({ viewport: { width: 320, height: 600 }, hasTouch: true });
  test.skip(before, "The baseline has no text attachment viewer");
  test("retries image and file downloads without losing the older message", async ({ page }) => {
    await page.goto("/tests/fixtures/search-reading-flow/index.html?theme=dark&image=retry&file=retry");
    await page.getByTestId("studio-search-input").fill("navigation");
    await page.getByTestId("studio-search-result-message-original").click();
    await page.getByTestId("chat-image-attachment-retry").click();
    await expect(page.getByTestId("chat-image-attachment-thumbnail")).toBeVisible();
    const file = page.getByTestId("chat-file-attachment");
    await file.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("chat-file-attachment-content")).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download file", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("navigation-review-notes-for-the-autumn-website-refresh.md");
    expect(await readFile((await download.path())!, "utf8")).toContain("# Navigation review");
    await insideViewport(page, page.getByRole("button", { name: "Close attachment" }));
    await page.getByRole("button", { name: "Close attachment" }).click();
    await expect(file).toBeFocused();
    await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", target);
    await noHorizontalOverflow(page);
  });

  test("keeps an unavailable file recoverable through closing the preview", async ({ page }) => {
    await openOlderMessage(page, "light", "&file=unavailable");
    const file = page.getByTestId("chat-file-attachment");
    await file.click();
    await expect(page.getByRole("dialog").getByRole("status")).toBeVisible();
    await expect(page.getByTestId("chat-file-attachment-content")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(file).toBeFocused();
    await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", target);
  });

  test("keeps keyboard focus on paging controls at both file boundaries", async ({ page }) => {
    await openOlderMessage(page, "dark", "&file=large");
    const file = page.getByTestId("chat-file-attachment");
    await file.click();
    const preview = page.getByRole("dialog");
    await expect(page.getByTestId("chat-file-attachment-content")).toBeVisible();
    const next = preview.getByRole("button", { name: "Next", exact: true });
    const previous = preview.getByRole("button", { name: "Previous", exact: true });
    await next.focus();
    await next.press("Enter");
    await expect(preview.getByRole("status").filter({ hasText: /^Page / })).toHaveText("Page 2");
    await expect(page.getByTestId("chat-file-attachment-content")).toBeVisible();
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(next).toBeFocused();
    await previous.focus();
    await previous.press("Enter");
    await expect(preview.getByRole("status").filter({ hasText: /^Page / })).toHaveText("Page 1");
    await expect(page.getByTestId("chat-file-attachment-content")).toBeVisible();
    await expect(previous).toHaveAttribute("aria-disabled", "true");
    await expect(previous).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(file).toBeFocused();
  });
});

test.describe("long scope names", () => {
  test.use({ viewport: { width: 320, height: 438 }, hasTouch: true });
  test("keeps production picker labels on one line and scope removal reachable", async ({ page }) => {
    test.skip(before, "Shared coarse-pointer scope targets are new");
    await page.goto("/tests/fixtures/search-reading-flow/index.html?theme=dark&longNames=1");
    await page.getByTestId("studio-search-input").fill("navigation");
    const picker = page.getByTestId("sidebar-space-button");
    await expect(picker).toBeVisible();
    expect(await picker.locator(".truncate").evaluate(element => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    for (const button of [page.getByRole("button", { name: "Search all orgs", exact: true }), page.getByRole("button", { name: /^Search within / }), page.getByRole("button", { name: "Close search", exact: true })]) {
      await insideViewport(page, button);
      const rect = (await button.boundingBox())!;
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    await noHorizontalOverflow(page);
  });
});

for (const enlarged of [false, true]) {
  test.describe(enlarged ? "enlarged text" : "short attachment viewport", () => {
    test.use({ viewport: { width: 390, height: enlarged ? 760 : 438 }, hasTouch: true });
    test("keeps image and file close actions reachable and preserves the reading context", async ({ page }) => {
      test.skip(before, "The shared image and text dialogs are new");
      if (enlarged) await page.addInitScript(() => {
        addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "24px"; });
      });
      await openOlderMessage(page, "dark");
      await page.getByTestId("chat-image-attachment-thumbnail").click();
      await insideViewport(page, page.getByRole("dialog", { name: "Image preview" }));
      await insideViewport(page, page.getByTestId("chat-image-lightbox-close"));
      await noHorizontalOverflow(page);
      await page.getByTestId("chat-image-lightbox-close").click();
      if (enlarged) {
        const action = page.getByTestId("chat-message-actions").first();
        await action.focus();
        await expect(action).toBeFocused();
        const rect = (await action.boundingBox())!;
        const edge = await page.getByTestId("chat-message-scroll").evaluate(element => element.getBoundingClientRect().left + element.clientWidth);
        expect(rect.width).toBeGreaterThanOrEqual(66);
        expect(rect.height).toBeGreaterThanOrEqual(66);
        expect(rect.x + rect.width + 4).toBeLessThanOrEqual(edge);
      }
      const file = page.getByTestId("chat-file-attachment");
      await file.click();
      await expect(page.getByTestId("chat-file-attachment-content")).toBeVisible();
      await insideViewport(page, page.getByRole("dialog"));
      await insideViewport(page, page.getByRole("button", { name: "Close attachment" }));
      await insideViewport(page, page.getByRole("button", { name: "Download file", exact: true }));
      await noHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(file).toBeFocused();
      await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", target);
      await page.getByTestId("chat-new-messages").click();
      await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", "");
    });
  });
}

async function openImageReview(page: Page, theme: string, extra = "") {
  await openOlderMessage(page, theme, `&review=image${extra}`);
  await page.getByTestId("chat-input").fill("Keep this edited draft while inspecting the reference image.");
  const opener = page.getByTestId("chat-image-attachment-thumbnail");
  await opener.tap();
  await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
  await expect(page.getByTestId("chat-image-lightbox-image")).toBeVisible();
  return opener;
}

async function imageTouchGesture(page: Page, { dx = 0, dy = 0, cancel = false, multi = false, afterStart }: {
  dx?: number; dy?: number; cancel?: boolean; multi?: boolean; afterStart?: () => Promise<void>;
}) {
  const rect = (await page.getByTestId("chat-image-lightbox-image").boundingBox())!;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const session = await page.context().newCDPSession(page);
  const points = (progress: number) => [
    { id: 1, x: x + dx * progress, y: y + dy * progress, radiusX: 2, radiusY: 2, force: 1 },
    ...(multi ? [{ id: 2, x: x + 24 + dx * progress, y: y + dy * progress, radiusX: 2, radiusY: 2, force: 1 }] : []),
  ];
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
    await afterStart?.();
    for (const progress of [.25, .5, .75, 1]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(progress) });
    await session.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}

async function emptyImageStagePoint(page: Page) {
  const stage = (await page.getByTestId("chat-image-lightbox-stage").boundingBox())!;
  const image = (await page.getByTestId("chat-image-lightbox-image").boundingBox())!;
  const close = (await page.getByTestId("chat-image-lightbox-close").boundingBox())!;
  const outside = (x: number, y: number, rect: typeof image) => x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height;
  const candidates = [[stage.x + 12, stage.y + 100], [stage.x + stage.width / 2, stage.y + stage.height - 12], [stage.x + 12, stage.y + stage.height / 2]];
  const point = candidates.find(([x, y]) => outside(x, y, image) && outside(x, y, close));
  expect(point).toBeDefined();
  return { x: point![0], y: point![1] };
}

const imageReviewCases = [
  { name: "phone-320", width: 320, height: 760, touch: true, immersive: true },
  { name: "phone-390", width: 390, height: 760, touch: true, immersive: true },
  { name: "boundary-767", width: 767, height: 900, touch: true, immersive: true },
  { name: "tablet-768", width: 768, height: 900, touch: true, immersive: false },
  { name: "landscape-touch", width: 844, height: 390, touch: true, immersive: true },
  { name: "landscape-mouse", width: 844, height: 390, touch: false, immersive: false },
  { name: "desktop", width: 1280, height: 900, touch: false, immersive: false },
  { name: "tall-image", width: 390, height: 844, touch: true, immersive: true, shape: "tall" },
];

for (const theme of ["light", "dark"]) {
  for (const view of imageReviewCases) {
    test.describe(`mobile image preview ${theme} ${view.name}`, () => {
      test.use({ viewport: { width: view.width, height: view.height }, hasTouch: view.touch });
      test("fits the image and dismissal controls without changing the reading context", async ({ page }) => {
        await page.addInitScript(() => addEventListener("DOMContentLoaded", () => {
          for (const [side, value] of Object.entries({ top: 28, right: 24, bottom: 16, left: 20 })) {
            document.documentElement.style.setProperty(`--instafy-safe-area-inset-${side}`, `${value}px`);
          }
        }));
        await openOlderMessage(page, theme, `&review=image${view.shape ? `&imageShape=${view.shape}` : ""}`);
        const opener = page.getByTestId("chat-image-attachment-thumbnail");
        if (view.touch) await opener.tap(); else await opener.click();
        const dialog = page.getByRole("dialog", { name: "Image preview" });
        const preview = page.getByTestId("chat-image-lightbox-image");
        const close = page.getByTestId("chat-image-lightbox-close");
        await expect(preview).toBeVisible();
        await insideViewport(page, dialog);
        await insideViewport(page, close);
        // The existing framed desktop body scrolls at short viewport heights.
        if (!before || view.height >= 500) await insideViewport(page, preview);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (!before) {
          await expect(page.getByTestId("chat-image-lightbox-stage")).toHaveAttribute("data-immersive", String(view.immersive));
          const rect = (await dialog.boundingBox())!;
          const closeRect = (await close.boundingBox())!;
          if (view.immersive) {
            expect(rect).toEqual({ x: 0, y: 0, width: view.width, height: view.height });
            expect(closeRect.y).toBeGreaterThanOrEqual(28);
            expect(closeRect.x + closeRect.width).toBeLessThanOrEqual(view.width - 24);
            expect(closeRect.y).toBeLessThanOrEqual(30);
            expect(closeRect.width).toBeGreaterThanOrEqual(44);
            expect(closeRect.height).toBeGreaterThanOrEqual(44);
            const heading = dialog.getByRole("heading");
            if (await heading.count()) {
              expect(await heading.evaluate(element => {
                for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
                  const style = getComputedStyle(ancestor);
                  if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") return true;
                }
                return false;
              })).toBe(true);
            }
          } else {
            expect(rect.x).toBeGreaterThan(0);
            expect(rect.width).toBeLessThan(view.width);
            await expect(dialog.getByRole("heading")).toBeVisible();
          }
        }
        if (view.shape) expect(await preview.evaluate(element => (element as HTMLImageElement).naturalHeight / (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(5);
        await capture(page, `mobile-image-${theme}-${view.name}`);
        const imageRect = (await preview.boundingBox())!;
        const imagePoint = { x: imageRect.x + imageRect.width / 2, y: imageRect.y + imageRect.height / 2 };
        if (view.touch) await page.touchscreen.tap(imagePoint.x, imagePoint.y); else await page.mouse.click(imagePoint.x, imagePoint.y);
        await expect(dialog).toBeVisible();
        await close.click();
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        await expect(page.getByTestId("chat-input")).not.toBeFocused();
        await expect(page.getByTestId("review-chat-pane")).toHaveAttribute("data-message-target", target);
      });
    });
  }

  test.describe(`mobile image gestures ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 760 }, hasTouch: true });
    test.skip(before, "Immersive image gestures are new");
    test("dismisses downward and by empty-space tap while retaining draft and opener focus", async ({ page }) => {
      const opener = await openImageReview(page, theme);
      await imageTouchGesture(page, { dy: 160 });
      await expect(page.getByRole("dialog", { name: "Image preview" })).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(page.getByTestId("chat-input")).toHaveText("Keep this edited draft while inspecting the reference image.");
      await opener.tap();
      const imageRect = (await page.getByTestId("chat-image-lightbox-image").boundingBox())!;
      await page.touchscreen.tap(imageRect.x + imageRect.width / 2, imageRect.y + imageRect.height / 2);
      await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
      const point = await emptyImageStagePoint(page);
      await page.touchscreen.tap(point.x, point.y);
      await expect(page.getByRole("dialog", { name: "Image preview" })).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.tap();
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      await expect(page.getByTestId("chat-input")).not.toBeFocused();
    });

    test("does not dismiss short, horizontal, upward, cancelled or multi-finger gestures", async ({ page }) => {
      await openImageReview(page, theme);
      for (const gesture of [{ dy: 16 }, { dx: 140, dy: 24 }, { dy: -120 }, { dy: 140, cancel: true }, { dy: 140, multi: true }]) {
        const resting = (await page.getByTestId("chat-image-lightbox-image").boundingBox())!;
        await imageTouchGesture(page, gesture);
        await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
        await expect.poll(async () => Math.abs((await page.getByTestId("chat-image-lightbox-image").boundingBox())!.y - resting.y)).toBeLessThan(1);
        await expect.poll(async () => (await page.getByTestId("chat-image-lightbox-image").boundingBox())!.width).toBeCloseTo(resting.width, 0);
      }
      await imageTouchGesture(page, { dy: 160 });
      await expect(page.getByRole("dialog", { name: "Image preview" })).toHaveCount(0);
    });
  });
}

test.describe("mobile image viewport changes", () => {
  test.use({ viewport: { width: 390, height: 760 }, hasTouch: true });
  test("cancels a swipe when the viewport changes or the page is zoomed", async ({ page }) => {
    test.skip(before, "Immersive image gestures are new");
    await openImageReview(page, "dark");
    await imageTouchGesture(page, { dy: 160, afterStart: () => page.setViewportSize({ width: 390, height: 700 }) });
    await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
      await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBeGreaterThan(1.01);
      await imageTouchGesture(page, { dy: 140 });
      await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBe(1);
      await imageTouchGesture(page, { dy: 160 });
      await expect(page.getByRole("dialog", { name: "Image preview" })).toHaveCount(0);
    } finally { await session.detach(); }
  });
});
