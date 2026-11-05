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
          await page.keyboard.press("Tab");
          await expect(page.getByTestId("chat-image-lightbox-close")).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(page.getByTestId("chat-image-lightbox-close")).toBeFocused();
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
