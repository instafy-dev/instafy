import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TIMELINE_BOUNDARIES, TIMELINE_REVIEW_NOW, timelineMessages } from "./timelineScenario";

const before = process.env.INSTAFY_TIME_REVIEW_VERSION === "before";
const version = before ? "before" : "after";
const base = `http://127.0.0.1:${before ? 5375 : 5372}/tests/fixtures/chat-pane-reading-space/index.html`;
const artifactRoot = process.env.INSTAFY_TIME_REVIEW_ARTIFACT_DIR;
const cases = [
  { id: "mobile-320", width: 320, height: 740, pane: 320, layout: "full" },
  { id: "mobile-390", width: 390, height: 844, pane: 390, layout: "full" },
  { id: "split-420", width: 1280, height: 900, pane: 420, layout: "split" },
  { id: "wide", width: 1440, height: 900, pane: 1440, layout: "full" },
];

async function openTimeline(page: Page, query = "") {
  await page.clock.setFixedTime(new Date(TIMELINE_REVIEW_NOW));
  await page.goto(`${base}?timeline=1&${query}`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0);
  await expect(page.getByTestId("browser-approval-row")).toHaveCount(0);
}

async function capture(page: Page, name: string) {
  if (!artifactRoot) return;
  await mkdir(path.join(artifactRoot, version), { recursive: true });
  await page.screenshot({ path: path.join(artifactRoot, version, `${name}.png`), animations: "disabled" });
}

async function checkBoundaries(page: Page) {
  const dividers = page.getByTestId("chat-time-divider");
  await expect(dividers).toHaveCount(before ? 0 : 3);
  if (before) return;
  for (const [index, boundary] of TIMELINE_BOUNDARIES.entries()) {
    await expect(dividers.nth(index)).toHaveAttribute("data-before-message-id", boundary.id);
    await expect(dividers.nth(index).locator("time")).toHaveAttribute("datetime", boundary.iso);
    await expect(dividers.nth(index).locator("time")).toHaveAttribute("title", /\S+/);
  }
}

for (const size of cases) test.describe(size.id, () => {
  test.use({ isMobile: size.width < 640, hasTouch: size.width < 640 });
  for (const theme of ["light", "dark"]) for (const people of ["solo", "group"]) {
    test(`${version} timeline ${size.id} ${theme} ${people}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize(size);
      await openTimeline(page, `pane=${size.pane}&layout=${size.layout}&theme=${theme}&people=${people}`);
      await checkBoundaries(page);
      const expectedIds = timelineMessages(people === "group").map(message => message.id);
      const observedIds = await page.locator("[data-chat-message-id]").evaluateAll(elements =>
        [...new Set(elements.map(element => element.getAttribute("data-chat-message-id")))],
      );
      expect(observedIds).toEqual(expectedIds);
      const sizes = await page.getByTestId("chat-message-scroll").evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      if (people === "solo") {
        await expect(page.getByTestId("chat-speaker-agent-profile")).toHaveCount(0);
        // Exact timestamps are available on demand; they are not repeated on
        // every completed reply after the date landmarks are introduced.
        await expect(page.locator('[data-chat-message-id="latest-assistant"] time')).toHaveCount(0);
      } else {
        await expect(page.getByTestId("chat-speaker-agent-profile").filter({ hasText: "route-planner" })).toHaveCount(1);
        await expect(page.getByText("Alex Morgan", { exact: true })).toBeAttached();
      }
      if (!before) {
        const geometry = await page.getByTestId("chat-time-divider").evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          const message = document.querySelector(`[data-chat-message-id="${element.getAttribute("data-before-message-id")}"]`)!;
          return { height: rect.height, scroll: element.scrollWidth, client: element.clientWidth, precedes: Boolean(element.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) };
        }));
        for (const divider of geometry) {
          expect(divider.height).toBeLessThanOrEqual(48);
          expect(divider.scroll).toBeLessThanOrEqual(divider.client + 1);
          expect(divider.precedes).toBe(true);
        }
      }
      const scroll = page.getByTestId("chat-message-scroll");
      await scroll.evaluate(element => element.scrollTo(0, 0));
      await expect(page.locator('[data-chat-message-id="timeline-yesterday-user"]').first()).toBeInViewport();
      await capture(page, `${size.id}-${theme}-${people}-start`);
      await scroll.evaluate(element => element.scrollTo(0, element.scrollHeight));
      await expect(page.locator('[data-chat-message-id="latest-assistant"]').last()).toBeInViewport();
      await capture(page, `${size.id}-${theme}-${people}-latest`);
      expect(errors).toEqual([]);
    });
  }
});

if (!before) {
  test("timeline landmarks and unsent draft survive pane resizing and scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openTimeline(page, "pane=420&people=group&theme=dark");
    await page.getByTestId("chat-input").fill("Keep this unsent draft while reviewing yesterday.");
    const separator = page.getByRole("separator");
    await separator.press("End");
    await checkBoundaries(page);
    await separator.press("Home");
    await checkBoundaries(page);
    await page.getByTestId("chat-message-scroll").evaluate(element => element.scrollTo(0, element.scrollHeight));
    await page.getByTestId("chat-message-scroll").evaluate(element => element.scrollTo(0, 0));
    await expect(page.getByTestId("chat-input")).toHaveText("Keep this unsent draft while reviewing yesterday.");
    await expect(page.getByTestId("chat-time-divider")).toHaveCount(3);
  });

  for (const width of [320, 1280]) test.describe(`timeline message details ${width}`, () => {
    test.use({ isMobile: width < 640, hasTouch: width < 640 });
    test("exact timestamp stays accessible without repeating it in the transcript", async ({ page }) => {
      await page.setViewportSize({ width, height: width < 640 ? 740 : 900 });
      await openTimeline(page, "pane=420&theme=light");
      await page.getByTestId("chat-message-scroll").evaluate(element => element.scrollTo(0, element.scrollHeight));
      const action = page.locator('[data-chat-message-id="latest-assistant"]').last().getByTestId("chat-message-actions");
      await action.press("Enter");
      await expect(page.getByTestId("chat-message-sent-time").locator("time")).toHaveAttribute("datetime", "2026-11-02T09:21:00.000Z");
      await expect(page.getByTestId("chat-message-sent-time")).toBeVisible();
      await capture(page, `timestamp-${width}-light`);
      await page.keyboard.press("Escape");
      await expect(action).toBeFocused();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  });

  test("group timeline retains the exact custom agent profile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTimeline(page, "layout=full&people=group");
    await page.getByTestId("chat-speaker-agent-profile").filter({ hasText: "route-planner" }).press("Enter");
    await expect(page.getByTestId("review-event")).toContainText('"agentId":"review-agent-planner"');
    await checkBoundaries(page);
  });
}
