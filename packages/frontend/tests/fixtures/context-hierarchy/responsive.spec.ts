import { expect, test, type Page } from "@playwright/test";
const fixture = "/tests/fixtures/context-hierarchy/index.html";
async function openPreview(page: Page, query: string) {
  await page.goto(`${fixture}?${query}`);
  await expect(
    page.getByTestId("source-control-history-entry").first(),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function expectReadableNarrowHistory(page: Page) {
  const rows = page.getByTestId("source-control-history-entry");
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    const review = await row
      .getByTestId("source-control-history-review")
      .boundingBox();
    const title = await row
      .getByTestId("source-control-history-summary")
      .boundingBox();
    const metadata = await row
      .getByTestId("source-control-history-metadata")
      .boundingBox();
    const toggle = await row
      .getByTestId("source-control-history-toggle")
      .boundingBox();
    expect(review).not.toBeNull();
    expect(title).not.toBeNull();
    expect(metadata).not.toBeNull();
    expect(toggle).not.toBeNull();
    if (!review || !title || !metadata || !toggle)
      throw new Error("Missing History row geometry");
    // Metadata must not squeeze the version title to an unreadable sliver.
    expect(title.width).toBeGreaterThan(150);
    expect(title.x).toBeGreaterThanOrEqual(review.x);
    expect(title.x + title.width).toBeLessThanOrEqual(
      review.x + review.width + 1,
    );
    expect(metadata.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(metadata.x + metadata.width).toBeLessThanOrEqual(
      review.x + review.width + 1,
    );
    expect(toggle.x).toBeGreaterThanOrEqual(review.x + review.width - 1);
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  }
  const badge = page.getByTestId("source-control-history-resolved-badge");
  await expect(badge).toBeVisible();
  await expect(
    page.getByTestId("source-control-history-metadata").filter({ has: badge }),
  ).toHaveCount(1);
}
for (const theme of ["light", "dark"]) {
  for (const width of [900, 1024, 1280, 1600]) {
    test(`docked History keeps titles and header aligned at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPreview(page, `theme=${theme}`);
      await expectNoHorizontalOverflow(page);
      await expectReadableNarrowHistory(page);
      const sidebar = await page
        .getByTestId("sidebar-context-navigation")
        .boundingBox();
      const pane = await page
        .getByRole("complementary", { name: "History pane" })
        .boundingBox();
      const header = await page
        .getByTestId("studio-desktop-drawer-header")
        .boundingBox();
      expect(sidebar).not.toBeNull();
      expect(pane).not.toBeNull();
      expect(header).not.toBeNull();
      if (!sidebar || !pane || !header)
        throw new Error("Missing desktop shell geometry");
      expect(Math.abs(sidebar.x + sidebar.width - pane.x)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(header.x - pane.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(header.width - pane.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(header.y + header.height - pane.y)).toBeLessThanOrEqual(
        1,
      );
      const picker = await page
        .getByTestId("sidebar-space-button")
        .boundingBox();
      const search = await page
        .getByTestId("studio-desktop-search-trigger")
        .boundingBox();
      if (!picker || !search) throw new Error("Missing context controls");
      expect(picker.x + picker.width).toBeLessThanOrEqual(search.x + 1);
      expect(search.x + search.width).toBeLessThanOrEqual(pane.x);
    });
  }
  for (const width of [320, 390]) {
    test(`History title, metadata and separate actions remain usable at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await openPreview(page, `theme=${theme}&mobile=1`);
      await expectNoHorizontalOverflow(page);
      await expectReadableNarrowHistory(page);
      const row = page.getByTestId("source-control-history-entry").first();
      const toggle = row.getByTestId("source-control-history-toggle");
      await page.evaluate(() =>
        window.addEventListener("review:status", () =>
          document.body.setAttribute("data-review-requested", "true"),
        ),
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(
        row.getByTestId("source-control-history-short-commit"),
      ).toBeVisible();
      await expect(page.locator("body")).not.toHaveAttribute(
        "data-review-requested",
        "true",
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await row.getByTestId("source-control-history-review").click();
      await expect(page.locator("body")).toHaveAttribute(
        "data-review-requested",
        "true",
      );
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    });
  }
  test(`space picker, search, collapse and Home preserve local navigation in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPreview(page, `theme=${theme}&shell=desktop`);
    await page.getByTestId("sidebar-space-button").click();
    await page.getByTestId("sidebar-recent-space-product").click();
    await expect(page.getByTestId("sidebar-space-button")).toHaveAccessibleName(
      "Choose space: Product website",
    );
    await page.getByTestId("studio-desktop-search-trigger").click();
    await expect(
      page.getByRole("textbox", { name: "Sample search" }),
    ).toBeFocused();
    await expect(page.getByTestId("studio-desktop-drawer-header")).toBeHidden();
    expect(
      await page
        .locator(".studio-desktop-context-column")
        .evaluate((element) => getComputedStyle(element, "::after").content),
    ).toBe("none");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByTestId("studio-desktop-search-trigger"),
    ).toBeFocused();
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(
      page
        .getByRole("complementary", { name: "History pane" })
        .getByRole("heading", { name: "History", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(
      page
        .getByTestId("studio-desktop-drawer-header")
        .getByRole("heading", { name: "History", exact: true }),
    ).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("studio-home-title")).toBeVisible();
    expect(
      await page
        .locator(".studio-desktop-context-column")
        .evaluate((element) => getComputedStyle(element, "::after").content),
    ).toBe("none");
    await expect(page.getByTestId("sidebar-context-navigation")).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: "History pane" }),
    ).toHaveCount(0);
    await page.getByTestId("home-return-navigation").click();
    await expect(page.getByTestId("sidebar-space-button")).toHaveAccessibleName(
      "Choose space: Product website",
    );
    await expect(
      page.getByRole("complementary", { name: "History pane" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
  test(`workspace tabs remain distinct and switchable in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture}?theme=${theme}&tabs=1`);
    const tabs = page.getByTestId("workspace-tabs");
    const first = tabs.locator('[data-workspace-tab-trigger="chat-1"]');
    const second = tabs.locator('[data-workspace-tab-trigger="chat-2"]');
    await expect(first).toBeVisible();
    await second.click();
    await expect(second.locator('[aria-current="page"]')).toBeVisible();
    await expect(first.locator('[aria-current="page"]')).toHaveCount(0);
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(first.locator('[aria-current="page"]')).toBeVisible();
    await tabs
      .getByRole("button", { name: "Close Website research", exact: true })
      .click();
    await expect(second).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
}
test("History remains readable with a 150% root font at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openPreview(page, "theme=dark&mobile=1");
  await page.addStyleTag({ content: "html { font-size: 24px; }" });
  await expectNoHorizontalOverflow(page);
  await expectReadableNarrowHistory(page);
});
for (const theme of ["light", "dark"]) {
  test(`full-width History uses available space without squeezing metadata in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await openPreview(page, `theme=${theme}&mobile=1`);
    await expectNoHorizontalOverflow(page);
    const first = page.getByTestId("source-control-history-entry").first();
    const title = await first
      .getByTestId("source-control-history-summary")
      .boundingBox();
    const metadata = await first
      .getByTestId("source-control-history-metadata")
      .boundingBox();
    if (!title || !metadata)
      throw new Error("Missing full-width History row geometry");
    expect(title.width).toBeGreaterThan(250);
    expect(metadata.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(Math.abs(metadata.y - title.y)).toBeLessThan(10);
    await expect(page.getByTestId("history-author").first()).toHaveText(
      "Alexandra Montgomery",
    );
  });
}

test.describe("wide touch layout", () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 900 } });
  for (const theme of ["light", "dark"]) {
    test(`touch targets fit the context and History header in ${theme}`, async ({
      page,
    }) => {
      await openPreview(page, `theme=${theme}`);
      await expectNoHorizontalOverflow(page);
      await expectReadableNarrowHistory(page);
      const picker = await page
        .getByTestId("sidebar-space-button")
        .boundingBox();
      const search = await page
        .getByTestId("studio-desktop-search-trigger")
        .boundingBox();
      const header = await page
        .getByTestId("studio-desktop-drawer-header")
        .boundingBox();
      const pane = await page
        .getByRole("complementary", { name: "History pane" })
        .boundingBox();
      if (!picker || !search || !header || !pane)
        throw new Error("Missing wide touch geometry");
      expect(search.height).toBeGreaterThanOrEqual(44);
      expect(picker.x + picker.width).toBeLessThanOrEqual(search.x + 1);
      expect(search.x + search.width).toBeLessThanOrEqual(pane.x);
      expect(Math.abs(header.y + header.height - pane.y)).toBeLessThanOrEqual(
        1,
      );
    });
  }
});
