import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prepareStudio } from "../utils/harness.js";

test("presents a durable conversation reply in the background without message contents", async ({ page }) => {
  const eventId = randomUUID();
  const conversationId = randomUUID();
  let projectId: string | null = null;
  let available = false;
  let seenAt: string | null = null;
  await page.route(/\/me\/notifications(?:\?|$)/, async (route) => {
    await route.fulfill({ json: {
      ok: true, nextCursor: null, unreadCount: available ? 1 : 0, asOf: new Date().toISOString(),
      items: available ? [{ id: eventId, version: 1, eventName: "conversation.reply", category: "conversations", resourceType: "conversation", resourceId: conversationId, occurredAt: new Date().toISOString(), title: "An unsafe arbitrary title", body: "Private prompt and assistant response", url: `/studio?projectId=${projectId}&conversationControllerId=${conversationId}`, seenAt, readAt: null, archivedAt: null }] : [],
    } });
  });
  await page.route(/\/me\/notifications\/preferences$/, (route) => route.fulfill({ json: { ok: true, hidePreviews: true, preferences: [{ category: "conversations", channel: "local", enabled: true }, { category: "conversations", channel: "web_push", enabled: false }] } }));
  await page.route(/\/me\/notifications\/state$/, async (route) => {
    seenAt = new Date().toISOString();
    await route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() => {
    const calls: Array<{ title: string; options?: { body?: string; tag?: string } }> = [];
    (window as unknown as { __PW_NOTIFICATIONS__?: typeof calls }).__PW_NOTIFICATIONS__ = calls;
    class FakeNotification {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      constructor(title: string, options?: { body?: string; tag?: string }) { calls.push({ title, options }); }
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
  });
  projectId = await prepareStudio(page, { waitForHostedRuntime: false });
  if (!projectId) throw new Error("spaceId missing");
  await page.evaluate(async () => {
    const client = (window as typeof window & { __INSTAFY_SUPABASE__?: { auth: { getSession: () => Promise<{ data: { session: { user: { id: string } } | null } }> } } }).__INSTAFY_SUPABASE__;
    const session = (await client?.auth.getSession())?.data.session;
    if (!session) throw new Error("Authenticated notification account missing");
    window.localStorage.setItem(`instafy.notifications.enabled:${session.user.id}`, "1");
    // Exercise local browser presentation, not real external delivery.
    (document as unknown as { hasFocus: () => boolean }).hasFocus = () => false;
  });
  available = true;
  await page.evaluate(() => window.dispatchEvent(new Event("instafy:notification-received")));
  const calls = () => page.evaluate(() => (window as unknown as { __PW_NOTIFICATIONS__: Array<{ title: string; options?: { body?: string; tag?: string } }> }).__PW_NOTIFICATIONS__);
  await expect.poll(async () => (await calls()).length).toBe(1);
  const notification = (await calls())[0];
  expect(notification.title).toBe("Instafy");
  expect(notification.options?.body).toBe("You have a new notification.");
  expect(notification.options?.tag).toBe(eventId);
  await page.evaluate(() => window.dispatchEvent(new Event("instafy:notification-received")));
  await expect(page.getByTestId("notification-center-unread")).toHaveText("1");
  expect(await calls()).toHaveLength(1);
});
