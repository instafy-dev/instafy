// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ nativeRegister: vi.fn(), nativeRemove: vi.fn(), webRegister: vi.fn(), webRemove: vi.fn(), account: vi.fn() }));
vi.mock("../nativePushRegistration", () => ({ ensureNativePushTokenRegistered: mocks.nativeRegister, unregisterNativePushToken: mocks.nativeRemove }));
vi.mock("../webPushRegistration", () => ({ ensureWebPushSubscriptionRegistered: mocks.webRegister, unregisterWebPushSubscription: mocks.webRemove }));
vi.mock("../notificationPresentation", () => ({ publishNotificationAccount: mocks.account }));
vi.mock("../assistantMessageNotifications", () => ({ areMessageNotificationsEnabled: () => true }));
import { changeNotificationSession } from "../notificationLifecycle";
import { getNotificationSession, notificationStorageKey, setNotificationSession } from "../notificationSession";
const A = { userId: "11111111-1111-4111-8111-111111111111", accessToken: "first-session" };
const B = { userId: "22222222-2222-4222-8222-222222222222", accessToken: "second-session" };
describe("account-scoped notification lifecycle", () => {
  beforeEach(() => { setNotificationSession(null); vi.clearAllMocks(); });
  it("removes with the old credentials before registering for the new account", async () => {
    await changeNotificationSession(A);
    const switched = changeNotificationSession(B);
    expect(getNotificationSession()).toEqual(B);
    await switched;
    expect(mocks.nativeRemove).toHaveBeenCalledWith(A);
    expect(mocks.webRemove).toHaveBeenCalledWith(A);
    expect(mocks.webRemove.mock.invocationCallOrder[0]).toBeLessThan(mocks.webRegister.mock.invocationCallOrder[1]);
    expect(mocks.account).toHaveBeenLastCalledWith(B.userId);
  });
  it("closes presentation and detaches subscriptions on signout", async () => {
    await changeNotificationSession(A);
    await changeNotificationSession(null);
    expect(getNotificationSession()).toBeNull();
    expect(mocks.nativeRemove).toHaveBeenCalledWith(A);
    expect(mocks.account).toHaveBeenLastCalledWith(null);
  });
  it("does not transfer a previous account's local opt-in", () => {
    setNotificationSession(A); const first = notificationStorageKey("enabled");
    setNotificationSession(B); const second = notificationStorageKey("enabled");
    expect(first).not.toEqual(second);
    window.localStorage.setItem(first, "1");
    expect(window.localStorage.getItem(second)).toBeNull();
  });
  it("only registers the final account during rapid switches", async () => {
    const one = changeNotificationSession(A);
    const two = changeNotificationSession(B);
    await Promise.all([one, two]);
    expect(mocks.nativeRegister).toHaveBeenCalledTimes(1);
    expect(mocks.account).toHaveBeenLastCalledWith(B.userId);
  });
  it("does not let a pending provider registration block sign-out cleanup", async () => {
    mocks.nativeRegister.mockImplementationOnce(() => new Promise(() => {}));
    mocks.webRegister.mockImplementationOnce(() => new Promise(() => {}));
    await changeNotificationSession(A);
    await changeNotificationSession(null);
    expect(mocks.nativeRemove).toHaveBeenCalledWith(A);
    expect(mocks.webRemove).toHaveBeenCalledWith(A);
  });

});
