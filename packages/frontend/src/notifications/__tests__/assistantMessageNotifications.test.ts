// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ subscription: vi.fn(), route: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("../webPushRegistration", () => ({ hasActiveWebPushSubscription: mocks.subscription, ensureWebPushSubscriptionRegistered: async () => true, unregisterWebPushSubscription: async () => true }));
vi.mock("../nativePushRegistration", () => ({ requestNativePushTokenRegistered: async () => false, unregisterNativePushToken: async () => true }));
vi.mock("../notificationPresentation", () => ({ routeNotificationClick: mocks.route }));
import { notifyAssistantMessage, setMessageNotificationsEnabled } from "../assistantMessageNotifications";
import { setNotificationSession } from "../notificationSession";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const payload = { title: "Private title", body: "Private body", url: `/studio?supportReportId=${B}`, eventId: B, accountId: A };
let notifications: Array<{ title: string; options: NotificationOptions; onclick?: () => void }>;
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); notifications = [];
  setNotificationSession({ userId: A, accessToken: "a" }); setMessageNotificationsEnabled(true);
  mocks.subscription.mockResolvedValue(false);
  class FakeNotification {
    static permission = "granted";
    constructor(public title: string, public options: NotificationOptions) { notifications.push(this); }
  }
  vi.stubGlobal("Notification", FakeNotification);
});
describe("local notification privacy and account races", () => {
  it("uses generic content for untrusted input, and safe descriptions for opt-in previews", async () => {
    await notifyAssistantMessage(payload);
    await notifyAssistantMessage({ ...payload, body: "There is a new reply to your support report." });
    expect(notifications[0].title).toBe("Instafy");
    expect(notifications[0].options.body).toBe("You have a new notification.");
    expect(notifications[1].options.body).toBe("There is a new reply to your support report.");
    expect(notifications[0].options.tag).toBe(B);
  });
  it("does not display an old-account notification when subscription lookup resolves after a switch", async () => {
    let complete: ((value: boolean) => void) | undefined;
    mocks.subscription.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = notifyAssistantMessage(payload);
    setNotificationSession({ userId: B, accessToken: "b" });
    complete?.(false); await pending;
    expect(notifications).toHaveLength(0);
  });
});
