import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prepareStudio } from "../utils/harness.js";

test("shows a notification when an assistant message arrives in the background", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ title: string; options?: { body?: string } }> = [];
    (window as unknown as { __PW_NOTIFICATIONS__?: typeof calls }).__PW_NOTIFICATIONS__ = calls;

    class FakeNotification {
      static permission = "granted";
      static async requestPermission() {
        return "granted";
      }

      constructor(title: string, options?: { body?: string }) {
        calls.push({ title, options });
      }
    }

    Object.defineProperty(window, "Notification", {
      value: FakeNotification,
      configurable: true,
    });

    try {
      window.localStorage.setItem("instafy.notifications.enabled", "1");
    } catch {
      // ignore storage errors
    }
  });

  const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
  if (!projectId) {
    throw new Error("spaceId missing");
  }

  await expect
    .poll(
      async () =>
        await page.evaluate(() => Boolean((window as any).__INSTAFY_E2E__?.emitConversationMessage)),
      { timeout: 10_000 },
    )
    .toBeTruthy();

  await page.evaluate(() => {
    (document as unknown as { hasFocus?: () => boolean }).hasFocus = () => false;
  });

  const conversationId = randomUUID();
  await page.evaluate(
    ({ projectId: pid, conversationId: cid }) => {
      (window as any).__INSTAFY_E2E__?.emitConversationMessage?.({
        projectId: pid,
        conversationId: cid,
        role: "assistant",
        content: "pong",
      });
    },
    { projectId, conversationId },
  );

  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => ((window as any).__PW_NOTIFICATIONS__ as Array<unknown> | undefined)?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const lastNotification = await page.evaluate(() => {
    const calls = (window as any).__PW_NOTIFICATIONS__ as Array<{ title: string; options?: { body?: string } }>;
    return calls.at(-1) ?? null;
  });
  expect(lastNotification?.title).toBeTruthy();
  expect(lastNotification?.options?.body ?? "").toContain("pong");
});
