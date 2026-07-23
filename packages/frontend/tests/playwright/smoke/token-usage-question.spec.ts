import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady
} from "../utils/harness.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";

function parseBadgeNumber(text: string | null, label: string): number {
  const normalized = (text ?? "").trim();
  const match = normalized.match(new RegExp(`^${label}\\s+(\\d+)$`, "i"));
  if (!match) {
    throw new Error(`Unable to parse ${label} badge value from "${normalized}"`);
  }
  return Number(match[1]);
}

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

test.describe("Token usage UI", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.describe.configure({ timeout: 240_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "token-usage:cleanup" }).catch(() => {});
  });

  test("shows token usage breakdown for an assistant reply", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for token usage test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "token-usage" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyForChat(page, projectId);

    const actionsButtons = page.getByTestId("chat-message-actions");
    const initialReplyCount = await actionsButtons.count();

    const firstPrompt = "What is 1+1? Reply with just the number.";
    await page.getByTestId("chat-input").fill(firstPrompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();

    await expect(actionsButtons).toHaveCount(initialReplyCount + 1, { timeout: 180_000 });
    const firstReplyAction = actionsButtons.nth(initialReplyCount);
    const firstReplyBubble = firstReplyAction.locator(
      "xpath=ancestor::*[@data-testid='chat-bubble-assistant'][1]",
    );
    await expectAssistantReplyOrSkipRateLimit(page, /\b2\b/, { timeout: 30_000 });
    await expect(firstReplyBubble).toBeVisible({ timeout: 30_000 });
    await firstReplyBubble.hover();
    await firstReplyAction.click();
    await expect(page.locator("button", { hasText: "Copy conversation" })).toBeVisible({ timeout: 30_000 });
    const tokenUsageMenuItem = page.locator("button", { hasText: "Message stats" });
    await expect(tokenUsageMenuItem).toBeVisible({ timeout: 30_000 });
    await tokenUsageMenuItem.click();

    const inputText = await page.getByText(/Input\s+\d+/).first().textContent();
    const cachedText = await page.getByText(/Cached\s+\d+/).first().textContent();
    const outputText = await page.getByText(/Output\s+\d+/).first().textContent();

    const inputTokens = parseBadgeNumber(inputText, "Input");
    const cachedTokens = parseBadgeNumber(cachedText, "Cached");
    const outputTokens = parseBadgeNumber(outputText, "Output");

    expect(inputTokens).toBeGreaterThanOrEqual(0);
    expect(cachedTokens).toBeGreaterThanOrEqual(0);
    expect(outputTokens).toBeGreaterThanOrEqual(0);

    // The message menu overlay is currently marked aria-hidden (UI overlay), so prefer a DOM
    // locator over getByRole() here.
    const copyButton = page.locator("button", { hasText: "Copy stats" });
    await expect(copyButton).toBeVisible({ timeout: 30_000 });
    await copyButton.click();

    await page.keyboard.press("Escape");
  });
});
