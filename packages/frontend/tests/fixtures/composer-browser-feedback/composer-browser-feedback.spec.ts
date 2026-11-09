import { expect, test, type Page } from "@playwright/test";

const fixture = "/tests/fixtures/composer-browser-feedback/index.html";
const draft = "Please compare these screenshots.\nFocus on the spacing and controls.";

async function open(page: Page, surface: string, theme: string, extra = "") {
  await page.goto(`${fixture}?surface=${surface}&theme=${theme}${extra}`);
  await expect(page.getByTestId("review-app")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const viewport = page.viewportSize()!;
  for (const element of await page.getByRole("button").all()) {
    if (!(await element.isVisible())) continue;
    const bounds = await element.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  }
}

for (const width of [320, 390, 768, 1280]) {
  for (const theme of ["light", "dark"]) {
    test.describe(`${width}px ${theme}`, () => {
      test.use({ viewport: { width, height: width < 768 ? 844 : 900 }, hasTouch: width < 768 });

      test("composer actions, goals, recording and browser feedback remain usable", async ({ page }) => {
        await open(page, "actions", theme);
        await expect(page.getByTestId("chat-input")).toContainText("Please compare these screenshots.");
        await page.getByRole("tab", { name: "Browser", exact: true }).click();
        await expect(page.getByTestId("review-view")).toHaveText("browser");
        await expect(page.getByTestId("composer-draft")).toHaveText(draft);
        await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await expect(page.getByTestId("review-view")).toHaveText("chat");
        await expectNoHorizontalOverflow(page);

        await open(page, "goal", theme);
        await page.getByTestId("chat-active-goal-summary").click();
        await expect(page.getByTestId("chat-active-goal-details")).toBeVisible();
        await page.getByRole("button", { name: "Pause goal", exact: true }).click();
        await expect(page.getByTestId("review-goal-status")).toHaveText("paused");
        await page.getByRole("button", { name: "Resume goal", exact: true }).click();
        await expect(page.getByTestId("review-goal-status")).toHaveText("active");
        await expect(page.getByTestId("composer-draft")).toHaveText(draft);
        await expectNoHorizontalOverflow(page);

        await open(page, "recording", theme);
        await expect(page.getByTestId("chat-voice-active-strip")).toBeVisible();
        await expect(page.getByTestId("chat-voice-active-strip-status")).toContainText("Recording");
        await expectNoHorizontalOverflow(page);

        await open(page, "browser-error", theme);
        await expect(page.getByTestId("review-browser-feedback")).toHaveAttribute("role", "alert");
        await expectNoHorizontalOverflow(page);
        const dismiss = page.getByRole("button", { name: "Dismiss browser message" });
        if (width < 768) {
          const bounds = await dismiss.boundingBox();
          expect(bounds!.width).toBeGreaterThanOrEqual(44);
          expect(bounds!.height).toBeGreaterThanOrEqual(44);
        }
        await dismiss.click();
        await expect(page.getByTestId("review-browser-feedback")).toHaveCount(0);
        await expect(page.getByTestId("review-browser-event")).toHaveText("dismiss");
        await expect(page.getByTestId("review-browser-toolbar")).toBeVisible();

        await open(page, "browser-status", theme);
        await page.getByRole("button", { name: "Resume agent control" }).click();
        await expect(page.getByTestId("review-browser-event")).toHaveText("resume");
        await expect(page.getByRole("button", { name: "Resume agent control" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        await open(page, "browser-success", theme);
        await expect(page.getByTestId("review-browser-feedback")).toHaveAttribute("role", "status");
        await expectNoHorizontalOverflow(page);
      });
    });
  }
}

test("keyboard can expand goal details and keep the draft", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "goal", "dark");
  const summary = page.getByTestId("chat-active-goal-summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("chat-active-goal-details")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("chat-active-goal-details")).toHaveCount(0);
  await expect(page.getByTestId("composer-draft")).toHaveText(draft);
});

test("disabled actions and pending Resume cannot run", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "goal", "light", "&disabled=1");
  await expect(page.getByRole("button", { name: "Pause goal", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Clear goal", exact: true })).toBeDisabled();
  await open(page, "browser-status", "light", "&pending=1");
  await expect(page.getByRole("button", { name: "Resume agent control" })).toBeDisabled();
  await expect(page.getByTestId("review-browser-event")).toHaveText("");
});

test("long feedback and expanded goal fit enlarged text and short landscape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "browser-error", "dark", "&text=large");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Dismiss browser message" }).click();
  await expect(page.getByTestId("review-browser-feedback")).toHaveCount(0);
  await page.setViewportSize({ width: 844, height: 390 });
  await open(page, "goal", "light");
  await page.getByTestId("chat-active-goal-summary").click();
  await expect(page.getByTestId("chat-active-goal-details")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Pause goal", exact: true }).click();
  await expect(page.getByTestId("review-goal-status")).toHaveText("paused");
});
