import { expect, test, type Page } from "@playwright/test";

const route = "/tests/fixtures/message-actions/index.html";
const profiles = [
  { name: "phone-320", width: 320, height: 740, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1280, height: 900, touch: false },
];

async function dialogWithinViewport(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const theme of ["light", "dark"]) {
  for (const profile of profiles) {
    test.describe(`${theme} ${profile.name}`, () => {
      test.use({ viewport: { width: profile.width, height: profile.height }, hasTouch: profile.touch, isMobile: profile.touch });

      test("keeps message actions reachable and preserves the draft and opener focus", async ({ page }) => {
        await page.goto(`${route}?theme=${theme}&surface=actions`);
        const draft = page.getByTestId("review-draft");
        await draft.fill("Keep this unsent draft while reviewing message actions.");
        const opener = page.getByTestId("review-open");
        await opener.click();
        await dialogWithinViewport(page);
        const dialog = page.getByRole("dialog", { name: "Message actions" });
        for (let index = 0; index < 12; index++) {
          await page.keyboard.press("Tab");
          expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
        }
        await dialog.getByRole("button", { name: "Copy message", exact: true }).click();
        await expect(page.getByTestId("review-event")).toHaveText("Copied message");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(draft).toHaveValue("Keep this unsent draft while reviewing message actions.");
        await expect(opener).toBeFocused();
        await opener.click();
        await page.getByRole("button", { name: "Reply to selection", exact: true }).click();
        await expect(page.getByTestId("review-event")).toHaveText("Reply to selection");
        await expect(opener).toBeFocused();
      });

      test("drills into stats and returns with keyboard focus before dismissing", async ({ page }) => {
        await page.goto(`${route}?theme=${theme}&surface=actions`);
        const opener = page.getByTestId("review-open");
        await opener.click();
        await page.getByRole("button", { name: "Message stats…", exact: true }).click();
        await dialogWithinViewport(page);
        await page.getByRole("button", { name: "Copy stats", exact: true }).click();
        await expect(page.getByTestId("review-event")).toHaveText("Copied stats");
        await expect(page.getByRole("dialog", { name: "Message stats" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: "Message actions" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Message stats…", exact: true })).toBeFocused();
        await page.getByRole("button", { name: "Message stats…", exact: true }).click();
        await page.getByRole("button", { name: /Back/ }).click();
        await expect(page.getByRole("button", { name: "Message stats…", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(opener).toBeFocused();
      });

      test("cancels invitation without sending or clearing the draft", async ({ page }) => {
        await page.goto(`${route}?theme=${theme}&surface=invite`);
        const opener = page.getByTestId("review-open");
        const draft = page.getByTestId("review-draft");
        const value = await draft.inputValue();
        await opener.click();
        await dialogWithinViewport(page);
        const cancel = page.getByRole("button", { name: "Cancel invitation", exact: true });
        if (profile.touch) await cancel.tap();
        else await cancel.click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByTestId("review-event")).toHaveText("Invitation cancelled");
        await expect(draft).toHaveValue(value);
        await expect(opener).toBeFocused();
        await opener.click();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(opener).toBeFocused();
        await opener.click();
        await page.getByRole("button", { name: "Send without @", exact: true }).click();
        await expect(page.getByTestId("review-event")).toHaveText("Sent without mention");
      });

      test("keeps a pending invitation open and prevents duplicate actions", async ({ page }) => {
        await page.goto(`${route}?theme=${theme}&surface=invite`);
        await page.getByTestId("review-open").click();
        await page.getByRole("button", { name: "Invite & send", exact: true }).click();
        await expect(page.getByTestId("review-event")).toHaveText("Invitation started");
        await expect(page.getByRole("button", { name: "Inviting…", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Send without @", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await page.mouse.click(2, 2);
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Tab");
        expect(await page.getByRole("dialog").evaluate(node => node.contains(document.activeElement))).toBe(true);
        await dialogWithinViewport(page);
      });
    });
  }

  test.describe(`small viewports ${theme}`, () => {
    test.use({ viewport: { width: 320, height: 420 }, hasTouch: true, isMobile: true });
    test("contains long invitation names and wrapped actions with enlarged text", async ({ page }) => {
      await page.goto(`${route}?theme=${theme}&surface=invite&names=long&text=large`);
      await page.getByTestId("review-open").click();
      await dialogWithinViewport(page);
      const close = page.getByRole("button", { name: "Cancel invitation", exact: true });
      const send = page.getByRole("button", { name: "Invite & send", exact: true });
      await expect(close).toBeInViewport();
      await expect(send).toBeInViewport();
      const explanation = page.getByRole("dialog").getByText(/These teammates can’t see this conversation yet:/);
      const readable = await explanation.evaluate(node => {
        let scroll = node.parentElement;
        while (scroll && !["auto", "scroll"].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
        if (!scroll) throw new Error("Invite content has no scrollable region");
        const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
        const viewportHeight = scroll.clientHeight;
        scroll.scrollTop = scroll.scrollHeight;
        const content = node.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        return { viewportHeight, lineHeight, visibleTextHeight: Math.min(content.bottom, viewport.bottom) - Math.max(content.top, viewport.top) };
      });
      expect(readable.viewportHeight).toBeGreaterThanOrEqual(readable.lineHeight * 2);
      expect(readable.visibleTextHeight).toBeGreaterThanOrEqual(readable.lineHeight * 2);
      await expect(send).toBeInViewport({ ratio: 1 });
      await explanation.evaluate(node => {
        let scroll = node.parentElement;
        while (scroll && !["auto", "scroll"].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
        if (scroll) scroll.scrollTop = 0;
      });
      await expect(close).toBeInViewport({ ratio: 1 });
      await close.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
    test("scrolls message stats without clipping the back or copy actions", async ({ page }) => {
      await page.goto(`${route}?theme=${theme}&surface=stats&text=large`);
      await page.getByTestId("review-open").click();
      await dialogWithinViewport(page);
      await page.getByRole("button", { name: "Copy stats", exact: true }).click();
      await expect(page.getByTestId("review-event")).toHaveText("Copied stats");
      await page.getByRole("button", { name: /Back/ }).click();
      await expect(page.getByRole("dialog", { name: "Message actions" })).toBeVisible();
    });
    test("keeps an enlarged bottom-right context menu within the viewport", async ({ page }) => {
      await page.goto(`${route}?theme=${theme}&surface=actions&text=large&anchor=edge`);
      await page.getByTestId("review-open").click();
      await dialogWithinViewport(page);
      await page.getByRole("button", { name: "Message stats…", exact: true }).click();
      await dialogWithinViewport(page);
      await expect(page.getByRole("button", { name: /Back/ })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Copy stats", exact: true })).toBeInViewport();
      const metrics = await page.getByRole("dialog").locator("dl").first().evaluate(node => {
        let scroll = node.parentElement;
        while (scroll && !["auto", "scroll"].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
        if (!scroll) throw new Error("Stats have no scrollable region");
        return { height: scroll.clientHeight, lineHeight: Number.parseFloat(getComputedStyle(node.querySelector("dt")!).lineHeight) };
      });
      expect(metrics.height).toBeGreaterThanOrEqual(metrics.lineHeight * 2);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Message stats…", exact: true })).toBeFocused();
      await expect(page.getByRole("button", { name: "Message stats…", exact: true })).toBeInViewport({ ratio: 1 });
    });
  });

  test.describe(`touch landscape ${theme}`, () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    test("keeps invitation actions reachable and returns focus after touch cancellation", async ({ page }) => {
      await page.goto(`${route}?theme=${theme}&surface=invite&names=long`);
      const opener = page.getByTestId("review-open");
      await opener.tap();
      await dialogWithinViewport(page);
      await expect(page.getByRole("button", { name: "Invite & send", exact: true })).toBeInViewport({ ratio: 1 });
      await page.getByRole("button", { name: "Cancel invitation", exact: true }).tap();
      await expect(opener).toBeFocused();
    });
    test("keeps message stats tools reachable in landscape", async ({ page }) => {
      await page.goto(`${route}?theme=${theme}&surface=stats`);
      await page.getByTestId("review-open").tap();
      await dialogWithinViewport(page);
      await expect(page.getByRole("button", { name: /Back/ })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "Copy stats", exact: true })).toBeInViewport({ ratio: 1 });
      await page.getByRole("button", { name: "Copy stats", exact: true }).tap();
      await expect(page.getByTestId("review-event")).toHaveText("Copied stats");
    });
  });

  test.describe(`very short viewport ${theme}`, () => {
    test.use({ viewport: { width: 320, height: 280 }, hasTouch: true, isMobile: true });
    test("keeps stats navigation and copy reachable at 320×280", async ({ page }) => {
      await page.goto(`${route}?theme=${theme}&surface=stats&anchor=edge`);
      await page.getByTestId("review-open").tap();
      await dialogWithinViewport(page);
      await expect(page.getByRole("button", { name: /Back/ })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "Copy stats", exact: true })).toBeInViewport({ ratio: 1 });
      await page.getByRole("button", { name: "Copy stats", exact: true }).tap();
      await expect(page.getByTestId("review-event")).toHaveText("Copied stats");
      await page.getByRole("button", { name: /Back/ }).tap();
      await expect(page.getByRole("button", { name: "Message stats…", exact: true })).toBeFocused();
      await expect(page.getByRole("button", { name: "Message stats…", exact: true })).toBeInViewport({ ratio: 1 });
    });
  });
}
