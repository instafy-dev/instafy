import { describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../client", () => ({ controllerJsonRequest: request }));
import { listProductNotifications, readAllProductNotifications, updateProductNotificationState } from "../productNotifications";
const ID = "11111111-1111-4111-8111-111111111111";
const item = { id: ID, version: 1, category: "support", eventName: "support.reply", url: `/studio?supportReportId=${ID}`, title: "arbitrary title", body: "private diagnostic content", occurredAt: "2026-09-06T12:00:00Z" };
describe("durable notification client", () => {
  it("accepts only v1 known events and replaces all content with safe registry text", async () => {
    request.mockResolvedValue({ success: true, value: { items: [item, { ...item, version: 2 }, { ...item, eventName: "support.internal_note" }, { ...item, url: "/studio?controllerAccessToken=secret" }, null], asOf: "2026-09-06T12:01:00Z", unreadCount: 1, nextCursor: null } });
    const page = await listProductNotifications({ accessToken: "account-token", view: "unread", before: "opaque" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].title).toBe("Instafy");
    expect(page.items[0].body).toBe("There is a new reply to your support report.");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/me/notifications", accessToken: "account-token", searchParams: { view: "unread", before: "opaque", limit: 25 } }));
  });
  it("sends only monotonic state actions and the server read-all cutoff", async () => {
    request.mockResolvedValue({ success: true, value: { ok: true } });
    await updateProductNotificationState({ id: ID, action: "archive", accessToken: "account-token" });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/me/notifications/state", body: { id: ID, action: "archive" }, accessToken: "account-token" }));
    await readAllProductNotifications({ before: "2026-09-06T12:01:00Z", accessToken: "account-token" });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/me/notifications/read-all", body: { before: "2026-09-06T12:01:00Z" } }));
  });
});
