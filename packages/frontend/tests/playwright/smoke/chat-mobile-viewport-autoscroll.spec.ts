import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

async function emulateTouchFirst(page: Parameters<typeof test.afterEach>[0]["page"]) {
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);
    const createMediaQueryList = (query: string, matches: boolean): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }) as MediaQueryList;

    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      get: () => 5,
    });

    window.matchMedia = (query: string) => {
      if (query === "(pointer: coarse)" || query === "(hover: none)") {
        return createMediaQueryList(query, true);
      }
      return originalMatchMedia(query);
    };
  });
}

async function driveComposerScrollTransition(page: Parameters<typeof test.afterEach>[0]["page"], steps: number[]) {
  await page.evaluate(async (scrollSteps) => {
    const scrollNode = document.querySelector('[data-testid="chat-message-scroll"]') as HTMLDivElement | null;
    const contentNode = scrollNode?.firstElementChild as HTMLDivElement | null;
    if (!scrollNode || !contentNode) {
      throw new Error("Chat scroll container missing.");
    }

    if (!contentNode.querySelector('[data-testid="chat-scroll-filler"]')) {
      const filler = document.createElement("div");
      filler.setAttribute("data-testid", "chat-scroll-filler");
      filler.style.height = "1600px";
      filler.style.width = "1px";
      filler.style.pointerEvents = "none";
      filler.style.opacity = "0";
      contentNode.appendChild(filler);
    }

    for (const scrollTop of scrollSteps) {
      scrollNode.scrollTop = scrollTop;
      scrollNode.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    }
  }, steps);
}

test.describe("Chat mobile viewport behavior", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-mobile-viewport-autoscroll:cleanup" }).catch(() => {});
  });

  test("stays pinned to bottom when the viewport height changes (mobile keyboard hide/show)", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(60_000);

    await page.setViewportSize({ width: 390, height: 844 });

    await prepareStudio(page);
    await disableAssistantIfPossible(page);

    const unique = Date.now();
    const message = `pw mobile viewport ${unique}`;

    const input = page.getByRole("textbox", { name: /ask octo/i });
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.click();
    await input.fill(message);
    await page.getByRole("button", { name: /send message/i }).click();

    await expect(page.getByTestId("chat-bubble-user").filter({ hasText: message }).last()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 5_000 });

    const scrollDistanceFromBottom = async () =>
      await page.getByTestId("chat-message-scroll").evaluate((node) => node.scrollHeight - (node.scrollTop + node.clientHeight));

    await expect.poll(scrollDistanceFromBottom, { timeout: 15_000 }).toBeLessThan(64);

    // Simulate keyboard open (smaller viewport) then hide (restore viewport).
    await page.setViewportSize({ width: 390, height: 560 });
    await page.waitForTimeout(250);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    await expect.poll(scrollDistanceFromBottom, { timeout: 15_000 }).toBeLessThan(64);

    const composerOverlay = page.getByTestId("chat-composer-overlay");
    await expect(composerOverlay).toBeVisible();
    const box = await composerOverlay.boundingBox();
    if (!box) {
      throw new Error("Unable to measure composer overlay bounds.");
    }
    const viewport = page.viewportSize();
    if (!viewport) {
      throw new Error("Viewport size missing.");
    }

    const distanceToBottom = viewport.height - (box.y + box.height);
    expect(distanceToBottom).toBeLessThan(160);
  });

  test("hides the mobile composer on upward scroll and restores it on downward scroll", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(60_000);

    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.blur();
      }
    });
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });

    const composer = page.getByTestId("chat-composer-overlay");
    await expect.poll(async () => await composer.getAttribute("class")).toContain("translate-y-0");

    await expect(async () => {
      await driveComposerScrollTransition(page, [24, 220]);
      await expect.poll(async () => await composer.getAttribute("class"), { timeout: 1_500 }).toContain(
        "translate-y-full",
      );
    }).toPass({ timeout: 8_000, intervals: [250, 500, 1_000] });

    await expect(async () => {
      await driveComposerScrollTransition(page, [160, 24]);
      await expect.poll(async () => await composer.getAttribute("class"), { timeout: 1_500 }).toContain(
        "translate-y-0",
      );
    }).toPass({ timeout: 8_000, intervals: [250, 500, 1_000] });
  });
});
