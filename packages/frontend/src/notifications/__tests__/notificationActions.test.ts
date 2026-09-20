// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ push: new Map<string, (payload: unknown) => void>(), local: new Map<string, (payload: unknown) => void>(), remove: vi.fn(), route: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: { addListener: async (event: string, callback: (payload: unknown) => void) => { mocks.push.set(event, callback); return { remove: mocks.remove }; } } }));
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: { addListener: async (event: string, callback: (payload: unknown) => void) => { mocks.local.set(event, callback); return { remove: mocks.remove }; } } }));
vi.mock("../notificationPresentation", () => ({ NOTIFICATION_NAVIGATE_EVENT: "test-notification-navigate", NOTIFICATION_RECEIVED_EVENT: "instafy:notification-received", routeNotificationClick: mocks.route }));
import { installNotificationActionListeners } from "../notificationActions";
// installNotificationActionListeners() registers through two awaited dynamic
// imports. Counting microtask ticks was enough while vitest 3 resolved a mocked
// import synchronously; vitest 4's mocker adds a hop past them. One macrotask
// drains the whole chain however many hops it grows.
async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }
beforeEach(() => vi.clearAllMocks());
describe("native notification action routing", () => {
  it("routes push and local actions including a cold-start callback", async () => {
    const stop = installNotificationActionListeners(); await flush();
    const payload = { eventId: "event", accountId: "account", url: "/studio" };
    mocks.push.get("pushNotificationActionPerformed")?.({ notification: { data: payload } });
    mocks.local.get("localNotificationActionPerformed")?.({ notification: { extra: payload } });
    expect(mocks.route).toHaveBeenNthCalledWith(1, payload);
    expect(mocks.route).toHaveBeenNthCalledWith(2, payload);
    stop();
    mocks.push.get("pushNotificationActionPerformed")?.({ notification: { data: payload } });
    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(mocks.remove).toHaveBeenCalledTimes(3);
  });
  it("removes listeners even if unmounted before plugin imports resolve", async () => {
    const stop = installNotificationActionListeners(); stop(); await flush();
    expect(mocks.remove).toHaveBeenCalledTimes(3);
  });
});
