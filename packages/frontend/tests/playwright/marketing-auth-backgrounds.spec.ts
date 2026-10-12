import { expect, test, type Locator, type Page } from "@playwright/test";

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const THEMES = ["dark", "light"] as const;

async function expectFullViewportPage(page: Page, root: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await root.boundingBox();

  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeCloseTo(0, 1);
  expect(box!.width).toBeCloseTo(viewport!.width, 1);
  expect(box!.height).toBeGreaterThanOrEqual(viewport!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport!.width,
  );

  // The page, body and document all show the same paper canvas, so
  // overscroll and rubber-band areas never flash a different colour.
  const rootBackground = await root.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const htmlBackground = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
  expect(rootBackground).toBe(bodyBackground);
  expect(htmlBackground).toBe(bodyBackground);
}

async function expectFullBleedLayer(page: Page, layer: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await layer.boundingBox();

  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(0);
  expect(box!.x + box!.width).toBeGreaterThanOrEqual(viewport!.width);
  expect(await layer.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
    "radial-gradient",
  );
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((mode) => {
        window.localStorage.setItem("instafy.themeMode", mode);
      }, theme);
    });

    test(`${theme} landing and login backgrounds stay full-bleed`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto("/");

      await expectFullViewportPage(page, page.getByTestId("landing-page"));
      await expect(page.getByTestId("landing-hero-heading")).toBeVisible();
      await expectFullBleedLayer(page, page.getByTestId("landing-dot-grid"));

      await page.goto("/login");
      await expectFullViewportPage(page, page.getByTestId("login-page"));
      await expectFullBleedLayer(page, page.getByTestId("login-dot-grid"));
      await expect(page.getByTestId("login-ambient-glow")).toHaveCount(0);

      await page.setViewportSize(PHONE_VIEWPORT);
      await page.goto("/");
      await expectFullViewportPage(page, page.getByTestId("landing-page"));
      await expect(page.getByTestId("landing-hero-heading")).toBeVisible();
      await expectFullBleedLayer(page, page.getByTestId("landing-dot-grid"));

      await page.goto("/login");
      await expectFullViewportPage(page, page.getByTestId("login-page"));
      await expect(page.getByTestId("login-dot-grid")).toBeHidden();
    });
  });
}

test("landing copy and metadata contain no em dashes", async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/");

  await expect(page.getByTestId("landing-page")).toBeVisible();
  expect(await page.locator("main").innerText()).not.toContain("\u2014");

  const descriptions = await page
    .locator(
      'meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]',
    )
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("content") ?? ""));
  expect(descriptions).not.toHaveLength(0);
  expect(descriptions.join("\n")).not.toContain("\u2014");
});
