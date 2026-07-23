import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";

function conversationTabButtons(page: Page) {
  return page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
}

async function resolveActiveConversationLocalId(page: Page): Promise<string> {
  const fromUrl = await page
    .evaluate(() => {
      try {
        return new URL(window.location.href).searchParams.get("conversationId");
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (typeof fromUrl === "string" && fromUrl.trim().length > 0) {
    return fromUrl.trim();
  }

  const fromStore = await page
    .evaluate(() => {
      const store = (window as any)?.__INSTAFY_STORE__;
      const state = store?.getState?.();
      return typeof state?.activeConversationId === "string" ? state.activeConversationId : null;
    })
    .catch(() => null);
  if (typeof fromStore === "string" && fromStore.trim().length > 0) {
    return fromStore.trim();
  }

  const tabs = conversationTabButtons(page);
  await expect(tabs).toHaveCount(1);
  const tabId = await tabs.first().getAttribute("data-tab-id");
  if (!tabId) {
    throw new Error("Conversation tab missing data-tab-id.");
  }
  return tabId.startsWith("workspace-conversation-")
    ? tabId.replace("workspace-conversation-", "")
    : tabId;
}

async function seedAssistantBubble(page: Page, projectId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            Boolean(
              (window as any).__INSTAFY_E2E__?.emitConversationMessage &&
                (window as any).__INSTAFY_E2E__?.createBlankConversation,
            ),
        ),
      { timeout: 10_000 },
    )
    .toBeTruthy();

  const localConversationId = await resolveActiveConversationLocalId(page);
  const controllerConversationId = await page.evaluate(
    async ({ currentProjectId, currentLocalConversationId }) => {
      return await (window as any).__INSTAFY_E2E__?.createBlankConversation?.({
        projectId: currentProjectId,
        metadata: { localId: currentLocalConversationId },
      });
    },
    { currentProjectId: projectId, currentLocalConversationId: localConversationId },
  );

  const normalizedConversationId =
    typeof controllerConversationId === "string" ? controllerConversationId.trim() : "";
  if (!normalizedConversationId) {
    throw new Error("Unable to seed assistant bubble (missing controller conversation id).");
  }

  const messageId = randomUUID();
  const createdAt = new Date().toISOString();
  const supabaseUrl = getSupabaseUrl().replace(/\/+$/, "");
  const headers = getSupabaseAuthHeaders();
  const seedResponse = await page.context().request.post(`${supabaseUrl}/rest/v1/conversation_messages`, {
    headers: {
      ...headers,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    data: {
      id: messageId,
      conversation_id: normalizedConversationId,
      project_id: projectId,
      role: "assistant",
      content: "OK",
      metadata: {
        localId: localConversationId,
      },
      created_at: createdAt,
    },
  });
  if (!seedResponse.ok()) {
    const body = await seedResponse.text().catch(() => "");
    throw new Error(`Failed to seed assistant bubble (${seedResponse.status()}): ${body.slice(0, 200)}`);
  }

  await page.evaluate(
    ({ currentProjectId, conversationId, currentLocalConversationId, nextMessageId, nextCreatedAt }) => {
      (window as any).__INSTAFY_E2E__?.emitConversationMessage?.({
        id: nextMessageId,
        projectId: currentProjectId,
        conversationId,
        role: "assistant",
        content: "OK",
        metadata: {
          conversationMetadata: { localId: currentLocalConversationId },
        },
        createdAt: nextCreatedAt,
      });
    },
    {
      currentProjectId: projectId,
      conversationId: normalizedConversationId,
      currentLocalConversationId: localConversationId,
      nextMessageId: messageId,
      nextCreatedAt: createdAt,
    },
  );

  await expect(page.locator('[data-testid="chat-bubble-assistant"]').last()).toContainText("OK");
}

test.describe("Chat message actions affordance", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-message-actions-affordance:cleanup" }).catch(() => {});
  });

  test("uses hover dots on desktop and long-press on mobile", async ({ page, browser }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Active project id missing for message actions affordance test.");
    }

    await page.getByTestId("sidebar-nav-chat").click();

    const actionsButtons = page.getByTestId("chat-message-actions");
    let actionsCount = await actionsButtons.count();

    if (actionsCount === 0) {
      await seedAssistantBubble(page, projectId);
      await expect.poll(async () => await actionsButtons.count(), { timeout: 90_000 }).toBeGreaterThan(0);

      actionsCount = await actionsButtons.count();
    }

    // Ensure we aren't accidentally hovering the bubble already.
    await page.mouse.move(2, 2);

    const desktopActions = actionsButtons.nth(Math.max(0, actionsCount - 1));
    const assistantBubble = desktopActions.locator("xpath=ancestor::*[@data-testid='chat-bubble-assistant'][1]");
    await expect(assistantBubble).toBeVisible({ timeout: 30_000 });

    const desktopOpacity = Number(
      await desktopActions.evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
    );
    const desktopPointerEvents = await desktopActions.evaluate((node) => getComputedStyle(node).pointerEvents);

    expect(desktopOpacity).toBeLessThanOrEqual(0.05);
    expect(desktopPointerEvents).toBe("none");

    await assistantBubble.hover();

    await expect.poll(
      async () =>
        Number(
          await desktopActions.evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
        ),
      { timeout: 5_000 },
    ).toBeGreaterThan(0.5);

    await expect.poll(
      async () => await desktopActions.evaluate((node) => getComputedStyle(node).pointerEvents),
      { timeout: 5_000 },
    ).toBe("auto");

    await desktopActions.click();
    await expect(page.locator("button", { hasText: "Copy conversation" })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    const scrollContainer = page.getByTestId("chat-message-scroll");
    const scrollBox = await scrollContainer.boundingBox();
    if (!scrollBox) {
      throw new Error("Unable to locate chat scroll container for transcript context menu test.");
    }
    await page.mouse.click(scrollBox.x + scrollBox.width - 24, scrollBox.y + scrollBox.height - 24, {
      button: "right",
    });
    await expect(page.locator("button", { hasText: "Copy conversation" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("button", { hasText: "Copy message" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    const mobileContext = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });

    try {
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(page.url(), { waitUntil: "domcontentloaded" });
      await mobilePage.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });

      const mobileActionsButtons = mobilePage.getByTestId("chat-message-actions");
      let mobileActionsCount = await mobileActionsButtons.count();
      if (mobileActionsCount === 0) {
        await seedAssistantBubble(mobilePage, projectId);
        await expect.poll(async () => await mobileActionsButtons.count(), { timeout: 90_000 }).toBeGreaterThan(0);
        mobileActionsCount = await mobileActionsButtons.count();
      }

      const mobileActions = mobileActionsButtons.nth(mobileActionsCount - 1);
      const mobileAssistantBubble = mobileActions.locator("xpath=ancestor::*[@data-testid='chat-bubble-assistant'][1]");
      await expect(mobileAssistantBubble).toBeVisible({ timeout: 30_000 });
      await expect(mobileActions).toBeHidden();

      const box = await mobileAssistantBubble.boundingBox();
      if (!box) {
        throw new Error("Unable to locate assistant bubble bounding box for long-press.");
      }
      const x = Math.floor(box.x + box.width * 0.65);
      const y = Math.floor(box.y + box.height * 0.65);

      await mobileAssistantBubble.dispatchEvent("pointerdown", {
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
        buttons: 1,
      });
      await mobilePage.waitForTimeout(520);
      await mobileAssistantBubble.dispatchEvent("pointerup", {
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
        buttons: 0,
      });

      await expect(mobilePage.locator("button", { hasText: "Copy conversation" })).toBeVisible({ timeout: 10_000 });
    } finally {
      await mobileContext.close().catch(() => {});
    }
  });
});
