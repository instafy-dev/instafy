import { test, expect, type Locator, type Page } from "@playwright/test";

async function openSearch(page: Page, theme: string, extra = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/tests/fixtures/search-keyboard/index.html?theme=${theme}${extra}`);
  await expect(page.getByTestId("studio-search-input")).toHaveValue("navigation");
  await expect(page.getByTestId("studio-search-input")).toBeFocused();
  expect(errors).toEqual([]);
}

async function fullyInsideResults(page: Page, target: Locator) {
  const list = await page.getByTestId("studio-search-results").boundingBox();
  const item = await target.boundingBox();
  expect(list).not.toBeNull();
  expect(item).not.toBeNull();
  expect(item!.y).toBeGreaterThanOrEqual(list!.y - 1);
  expect(item!.y + item!.height).toBeLessThanOrEqual(list!.y + list!.height + 1);
}

async function singleScrollOwner(page: Page) {
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > innerWidth,
    body: document.documentElement.scrollHeight > innerHeight + 1,
    owners: Array.from(document.querySelectorAll<HTMLElement>("#root *"))
      .filter(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1)
      .map(node => node.dataset.testid),
  }))).toEqual({ horizontal: false, body: false, owners: ["studio-search-results"] });
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 360, 390, 1280]) {
    test.describe(`${theme} ${width}px search`, () => {
      test.use({ viewport: { width, height: width < 900 ? 438 : 800 }, hasTouch: width < 900 });
      test("keeps the first actual result visible with query and scope controls", async ({ page }) => {
        await openSearch(page, theme);
        const result = page.getByTestId("studio-search-result-chat-0");
        await fullyInsideResults(page, result);
        await expect(page.getByRole("combobox", { name: "Search scope" })).toHaveValue("space");
        if (width < 900) expect(await page.getByTestId("studio-search-input").evaluate(node => getComputedStyle(node).fontSize)).toBe("16px");
        await page.getByTestId("studio-search-input").press("ArrowDown");
        await expect(result).toBeFocused();
        await result.press("Enter");
        expect(await page.evaluate(() => (window as unknown as { __searchKeyboardReview: { activations: number } }).__searchKeyboardReview.activations)).toBe(1);
        await expect(page.getByTestId("studio-search-results")).toHaveCount(0);
      });
    });
  }

  test.describe(`${theme} short search scrolling`, () => {
    test.use({ viewport: { width: 360, height: 438 }, hasTouch: true });
    test("scrolls results and the index explanation together while preserving input focus and scope", async ({ page }) => {
      await openSearch(page, theme, "&many=1");
      await singleScrollOwner(page);
      const input = page.getByTestId("studio-search-input");
      const inputBounds = await input.boundingBox();
      const list = page.getByTestId("studio-search-results");
      await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await fullyInsideResults(page, page.locator(".studio-search-footer"));
      await expect(input).toBeFocused();
      expect(await input.boundingBox()).toEqual(inputBounds);
      await expect(input).toHaveValue("navigation");
      await input.fill("Navigation follow-up 19");
      await expect(page.locator(".studio-search-result")).toHaveCount(1);
      await input.press("ArrowDown");
      await expect(page.getByTestId("studio-search-result-chat-19")).toBeFocused();
      await fullyInsideResults(page, page.getByTestId("studio-search-result-chat-19"));
    });

    test("keeps loading, error recovery and empty results reachable within native safe areas", async ({ page }) => {
      await page.addInitScript(() => {
        addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.setProperty("--safe-area-inset-top", "24px");
          document.documentElement.style.setProperty("--safe-area-inset-bottom", "16px");
        });
      });
      await openSearch(page, theme, "&state=loading");
      await fullyInsideResults(page, page.getByRole("status"));
      await expect(page.getByTestId("studio-search-results")).toHaveAttribute("aria-busy", "true");
      await page.evaluate(() => (window as unknown as { __searchKeyboardReview: { setStatus: (state: string) => void } }).__searchKeyboardReview.setStatus("error"));
      await fullyInsideResults(page, page.getByRole("alert"));
      await expect(page.getByTestId("studio-search-input")).toBeFocused();
      await page.getByRole("button", { name: "Retry search" }).click();
      expect(await page.evaluate(() => (window as unknown as { __searchKeyboardReview: { retries: number } }).__searchKeyboardReview.retries)).toBe(1);
      await fullyInsideResults(page, page.getByTestId("studio-search-result-chat-0"));
      await page.getByTestId("studio-search-input").fill("no matching chat");
      await fullyInsideResults(page, page.locator(".studio-search-empty"));
      await singleScrollOwner(page);
    });
  });
}
