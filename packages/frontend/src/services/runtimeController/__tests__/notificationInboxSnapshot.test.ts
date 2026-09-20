import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => vi.fn());
vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: context,
  readControllerError: async (response: Response, fallback: string) => `${fallback} (${response.status})`,
}));
import { acknowledgeMyNotificationInboxItem } from "../notifications";
const fetchMock = vi.fn();
const expectedUserId = "44444444-4444-4444-8444-444444444444";
const pin = { expectedUserId, accessToken: "user-token", isCurrent: () => true };
const conversationId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  vi.clearAllMocks();
  context.mockResolvedValue({ baseUrl: "http://controller.test", accessToken: "user-token" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("Home notification snapshot acknowledgement", () => {
  it("uses a distinct endpoint and preserves exact source and event IDs", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, inboxAcknowledged: false, acknowledgedNotificationIds: [eventId] })));
    const result = await acknowledgeMyNotificationInboxItem({ ...pin, conversationId, expectedLastMessageId: messageId, notificationIds: [eventId] });
    expect(fetchMock).toHaveBeenCalledWith("http://controller.test/me/notifications/inbox/ack-snapshot", expect.objectContaining({
      body: JSON.stringify({ conversationId, expectedLastMessageId: messageId, notificationIds: [eventId], expectedUserId }),
    }));
    expect(result).toEqual({ success: true, inboxAcknowledged: false, acknowledgedNotificationIds: [eventId] });
  });
  it("does not retry the legacy endpoint when an older controller rejects snapshots", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect((await acknowledgeMyNotificationInboxItem({ ...pin, conversationId, notificationIds: [] })).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("ack-snapshot");
  });
  it("does not claim an unconfirmed snapshot was acknowledged", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    expect((await acknowledgeMyNotificationInboxItem({ ...pin, conversationId, expectedLastMessageId: messageId })).success).toBe(false);
  });
  it("rejects replaced credentials and an account switch during context resolution", async () => {
    context.mockResolvedValueOnce({ baseUrl: "http://controller.test", accessToken: "other-user-token" });
    expect((await acknowledgeMyNotificationInboxItem({ ...pin, conversationId, notificationIds: [] })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    let stillCurrent = true;
    context.mockImplementationOnce(async () => { stillCurrent = false; return { baseUrl: "http://controller.test", accessToken: "user-token" }; });
    expect((await acknowledgeMyNotificationInboxItem({ ...pin, conversationId, notificationIds: [], isCurrent: () => stillCurrent })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves the old endpoint and response for callers without a snapshot", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    expect(await acknowledgeMyNotificationInboxItem({ conversationId })).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith("http://controller.test/me/notifications/inbox/ack", expect.objectContaining({ body: JSON.stringify({ conversationId }) }));
  });
});
