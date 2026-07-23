import { test, expect, type Locator, type Page } from "@playwright/test";
import { ensureRealDefaultCodexCredentialWhenRequired, prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

test.use({ trace: "off" });

function assistantBubbles(page: Page): Locator {
  return page.locator('[data-testid="chat-bubble-assistant"]');
}

function hasEmojiSuffix(text: string): boolean {
  return /😆[.!?)\]]*\s*$/u.test(text.trimEnd());
}

async function sendChat(page: Page, message: string) {
  await page.getByTestId("chat-input").fill(message);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 90_000 });
  await page.getByTestId("chat-send-button").click();
}

async function waitForAssistantIdle(page: Page, timeoutMs = 240_000) {
  const typingIndicator = page.getByTestId("assistant-typing-indicator");
  await typingIndicator.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});
}

async function setOctoDescription(page: Page, description: string): Promise<string | null> {
  await openSidebarSecondaryItem(page, "ai");
  await expect(page.getByTestId("ai-panel")).toBeVisible();

  const editButton = page.getByTestId("bots-octo-edit");
  const canEdit =
    (await editButton.isVisible().catch(() => false)) &&
    !(await editButton.isDisabled().catch(() => true));
  if (!canEdit) {
    return null;
  }

  await editButton.click();
  await expect(page.getByTestId("agent-profile-modal")).toBeVisible();

  const descriptionInput = page.getByTestId("agent-profile-description-input");
  const previousDescription = await descriptionInput.inputValue().catch(() => "");
  await descriptionInput.fill(description);

  const saveResponse = page.waitForResponse(
    (response) =>
      response.ok() &&
      response.request().method() === "PATCH" &&
      /\/me\/agents\/[^/]+$/.test(response.url()),
    { timeout: 60_000 },
  );
  await page.getByTestId("agent-profile-save").click();
  await saveResponse;
  await expect(page.getByTestId("agent-profile-modal")).toBeHidden({ timeout: 30_000 });
  return previousDescription;
}

test.describe("AI Manager (@octo flavor)", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );

  test("updates @octo flavor and sees 😆 suffix in chat", async ({ page }) => {
    test.setTimeout(420_000);
    page.setDefaultTimeout(60_000);

    await prepareStudio(page);
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    const cleanupDescription = await setOctoDescription(page, "Always end every reply with the emoji 😆.");
    if (cleanupDescription === null) {
      test.skip(true, "@octo profile is unavailable for editing in this environment.");
      return;
    }
    try {
      await page.getByTestId("sidebar-nav-chat").click();
      let previousCount = await assistantBubbles(page).count();
      let seenEmojiSuffix = false;

      for (let attempt = 0; attempt < 2 && !seenEmojiSuffix; attempt += 1) {
        await sendChat(page, "@octo Hello");
        await expect
          .poll(async () => await assistantBubbles(page).count(), { timeout: 240_000 })
          .toBeGreaterThan(previousCount);
        await waitForAssistantIdle(page, 240_000);
        const texts = await assistantBubbles(page).allTextContents().catch(() => []);
        seenEmojiSuffix = texts.some((text) => hasEmojiSuffix(text));
        previousCount = texts.length;
      }

      expect(seenEmojiSuffix).toBe(true);
    } finally {
      await setOctoDescription(page, cleanupDescription).catch(() => {});
    }
  });
});
