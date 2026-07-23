import { expect, test, type Locator, type Page } from "@playwright/test";

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const PHONE_VIEWPORT = { width: 390, height: 844 };

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

  const rootBackground = await root.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(rootBackground).toBe(bodyBackground);
}

async function expectFullBleedGlow(page: Page, glow: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await glow.boundingBox();

  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(0);
  expect(box!.x + box!.width).toBeGreaterThanOrEqual(viewport!.width);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("instafy.themeMode", "dark");
  });
});

test("dark landing and login backgrounds stay full-bleed", async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/");

  await expectFullViewportPage(page, page.getByTestId("landing-page"));
  await expectFullBleedGlow(page, page.getByTestId("landing-ambient-glow"));

  await page.goto("/login");
  await expectFullViewportPage(page, page.getByTestId("login-page"));
  await expectFullBleedGlow(page, page.getByTestId("login-ambient-glow"));

  await page.setViewportSize(PHONE_VIEWPORT);
  await page.goto("/");
  await expectFullViewportPage(page, page.getByTestId("landing-page"));
  await expectFullBleedGlow(page, page.getByTestId("landing-ambient-glow"));

  await page.goto("/login");
  await expectFullViewportPage(page, page.getByTestId("login-page"));
  await expect(page.getByTestId("login-ambient-glow")).toBeHidden();
});

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
