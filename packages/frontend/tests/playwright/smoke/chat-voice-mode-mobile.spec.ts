import { expect, test } from "@playwright/test";
import {
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";

test.describe("Mobile chat voice controls", () => {
  test.setTimeout(240_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-voice-mode-mobile:cleanup" }).catch(() => {});
  });

  test("keeps voice controls inside the same mobile chat", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    await prepareStudio(page);
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    const left = 19;
    const right = 29;
    const expectedAnswer = String(left + right);
    const prompt = `What is ${left}+${right}? Reply with just the number.`;
    const latestAssistantBubble = page.locator(
      '[data-testid="chat-bubble-assistant"]:not([data-message-type="token_usage"]):not([data-message-type="status"]):not([data-message-type="error"])',
    ).last();

    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("chat-bubble-user").last()).toContainText(prompt, { timeout: 30_000 });
    await expectAssistantReplyOrSkipRateLimit(page, /[\s\S]+/, { timeout: 120_000 });
    await expect(latestAssistantBubble).toContainText(expectedAnswer, {
      timeout: 30_000,
    });

    await expect(page).toHaveURL(/\/studio(?:\?|$)/);
    await expect(page.getByTestId("chat-open-voice-mode-button")).toHaveCount(0);
    await expect(page.getByTestId("chat-voice-input-button")).toBeVisible();
    await expect(page.getByTestId("chat-bubble-user").last()).toContainText(prompt);
    await expect(latestAssistantBubble).toContainText(expectedAnswer);
  });
});
