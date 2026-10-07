// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ subscription: vi.fn(), registerWeb: vi.fn(), unregisterWeb: vi.fn(), unregisterNative: vi.fn(), permission: vi.fn(), route: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("../webPushRegistration", () => ({ hasActiveWebPushSubscription: mocks.subscription, ensureWebPushSubscriptionRegistered: mocks.registerWeb, unregisterWebPushSubscription: mocks.unregisterWeb }));
vi.mock("../nativePushRegistration", () => ({ requestNativePushTokenRegistered: async () => false, unregisterNativePushToken: mocks.unregisterNative }));
vi.mock("../notificationPresentation", () => ({ routeNotificationClick: mocks.route }));
import { areMessageNotificationsEnabled, disableMessageNotifications, enableBrowserMessageNotifications, notifyAssistantMessage, setMessageNotificationsEnabled } from "../assistantMessageNotifications";
import { setNotificationSession } from "../notificationSession";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const payload = { title: "Private title", body: "Private body", url: `/studio?supportReportId=${B}`, eventId: B, accountId: A };
let notifications: Array<{ title: string; options: NotificationOptions; onclick?: () => void }>;
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); notifications = [];
  setNotificationSession({ userId: A, accessToken: "a" }); setMessageNotificationsEnabled(true);
  mocks.subscription.mockResolvedValue(false);
  mocks.registerWeb.mockResolvedValue(true);
  mocks.unregisterWeb.mockResolvedValue(true);
  mocks.unregisterNative.mockResolvedValue(true);
  mocks.permission.mockResolvedValue("granted");
  class FakeNotification {
    static permission = "granted";
    static requestPermission = mocks.permission;
    constructor(public title: string, public options: NotificationOptions) { notifications.push(this); }
  }
  vi.stubGlobal("Notification", FakeNotification);
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("device notification opt-in", () => {
  it("reads an explicit account without changing the current-session default", () => {
    setNotificationSession({ userId: B, accessToken: "b" });
    setMessageNotificationsEnabled(false);
    setNotificationSession({ userId: A, accessToken: "a" });
    expect(areMessageNotificationsEnabled(B)).toBe(false);
    expect(areMessageNotificationsEnabled()).toBe(true);
    expect(areMessageNotificationsEnabled(A)).toBe(true);
  });

  it("waits for completed push registration before enabling the device", async () => {
    setMessageNotificationsEnabled(false);
    let complete: ((value: boolean) => void) | undefined;
    mocks.registerWeb.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = enableBrowserMessageNotifications();
    await Promise.resolve();
    expect(areMessageNotificationsEnabled()).toBe(false);
    complete?.(true);
    expect(await pending).toBe(true);
    expect(areMessageNotificationsEnabled()).toBe(true);
  });

  it("reports registration failure despite granted browser permission", async () => {
    mocks.registerWeb.mockResolvedValue(false);
    expect(await enableBrowserMessageNotifications()).toBe(false);
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it("keeps failed setup disabled when push registration throws", async () => {
    setMessageNotificationsEnabled(false);
    mocks.registerWeb.mockRejectedValue(new Error("Registration failed"));
    await expect(enableBrowserMessageNotifications()).rejects.toThrow("Registration failed");
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it("does not register push when browser permission is denied", async () => {
    mocks.permission.mockResolvedValue("denied");
    expect(await enableBrowserMessageNotifications()).toBe(false);
    expect(mocks.registerWeb).not.toHaveBeenCalled();
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it("does not register push if the account changes during the permission prompt", async () => {
    let complete: ((value: string) => void) | undefined;
    mocks.permission.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = enableBrowserMessageNotifications();
    setNotificationSession({ userId: B, accessToken: "b" });
    setMessageNotificationsEnabled(false);
    complete?.("granted");
    expect(await pending).toBe(false);
    expect(mocks.registerWeb).not.toHaveBeenCalled();
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it.each([false, true])("ignores registration success=%s after an account switch", async (registered) => {
    let complete: ((value: boolean) => void) | undefined;
    mocks.registerWeb.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = enableBrowserMessageNotifications();
    await Promise.resolve();
    setNotificationSession({ userId: B, accessToken: "b" });
    setMessageNotificationsEnabled(!registered);
    complete?.(registered);
    expect(await pending).toBe(false);
    expect(areMessageNotificationsEnabled()).toBe(!registered);
  });

  it("ignores stale registration when returning to the initiating account", async () => {
    setMessageNotificationsEnabled(false);
    let complete: ((value: boolean) => void) | undefined;
    mocks.registerWeb.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = enableBrowserMessageNotifications();
    await Promise.resolve();
    setNotificationSession({ userId: B, accessToken: "b" });
    setNotificationSession({ userId: A, accessToken: "new-a" });
    complete?.(true);
    expect(await pending).toBe(false);
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it.each([[true, true], [false, true], [true, false]])("reports cleanup results without restoring opt-in: native=%s web=%s", async (nativeOk, webOk) => {
    mocks.unregisterNative.mockResolvedValue(nativeOk);
    mocks.unregisterWeb.mockResolvedValue(webOk);
    expect(await disableMessageNotifications()).toBe(nativeOk && webOk);
    expect(mocks.unregisterNative).toHaveBeenCalledOnce();
    expect(mocks.unregisterWeb).toHaveBeenCalledOnce();
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it("keeps local opt-in off when unregistering throws", async () => {
    mocks.unregisterWeb.mockRejectedValue(new Error("Cleanup failed"));
    await expect(disableMessageNotifications()).rejects.toThrow("Cleanup failed");
    expect(areMessageNotificationsEnabled()).toBe(false);
  });

  it("does not overwrite another account's opt-in after unregistering", async () => {
    let complete: ((value: boolean) => void) | undefined;
    mocks.unregisterWeb.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = disableMessageNotifications();
    expect(areMessageNotificationsEnabled()).toBe(false);
    setNotificationSession({ userId: B, accessToken: "b" });
    setMessageNotificationsEnabled(true);
    complete?.(false);
    expect(await pending).toBe(false);
    expect(areMessageNotificationsEnabled()).toBe(true);
  });
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
