import { test, expect } from "@playwright/test";
import {
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

test.describe("Chat Enter send", () => {
  test.setTimeout(240_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-enter-send:cleanup" }).catch(() => {});
  });

  test("pressing Enter sends a single-line chat message", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
    await disableAssistantIfPossible(page);

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();

    await chatInput.fill("hello");
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
    await chatInput.evaluate((node) => {
      const target = node as HTMLElement;
      target.focus();
      const keydown = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(keydown);
      const keyup = new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(keyup);
    });
    await expect
      .poll(
        async () => ((await chatInput.innerText().catch(() => "")) ?? "").trim(),
        { timeout: 15_000, message: "Enter should submit and clear the composer" },
      )
      .toBe("");

    const userBubble = page
      .getByTestId("chat-bubble-user")
      .filter({ hasText: "hello" })
      .first();
    const queueSurface = page.getByTestId("chat-send-queue");
    await expect
      .poll(
        async () => {
          const bubbleVisible = await userBubble.isVisible().catch(() => false);
          if (bubbleVisible) {
            return true;
          }
          const queuedVisible = await queueSurface.isVisible().catch(() => false);
          return queuedVisible;
        },
        { timeout: 15_000, message: "Enter should either send immediately or queue the prompt" },
      )
      .toBe(true);
  });
});
