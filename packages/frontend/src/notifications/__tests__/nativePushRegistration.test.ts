// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ platform: "ios", upsert: vi.fn(), remove: vi.fn(), register: vi.fn(), unregister: vi.fn(), request: vi.fn(), listeners: new Map<string, (value: unknown) => void>() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => mocks.platform } }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: { upsertNativePushToken: mocks.upsert, removeNativePushToken: mocks.remove } } }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: { addListener: vi.fn(async (name: string, callback: (value: unknown) => void) => { mocks.listeners.set(name, callback); return { remove: vi.fn() }; }), register: mocks.register, unregister: mocks.unregister, checkPermissions: async () => ({ receive: "granted" }), requestPermissions: mocks.request } }));
import { ensureNativePushTokenRegistered, unregisterNativePushToken } from "../nativePushRegistration";
import { notificationStorageKey, setNotificationSession } from "../notificationSession";
const SESSION = { userId: "11111111-1111-4111-8111-111111111111", accessToken: "old-user-token" };
describe("native push registration", () => {
  beforeEach(async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); vi.clearAllMocks(); window.localStorage.clear(); mocks.platform = "ios"; mocks.upsert.mockResolvedValue({ success: true }); mocks.remove.mockResolvedValue({ success: true }); setNotificationSession(SESSION); });
  it("explicitly disables Android rather than accepting undeliverable tokens", async () => {
    mocks.platform = "android";
    expect(await ensureNativePushTokenRegistered()).toBe(false);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("removes a legacy Android token with Android, using the captured account", async () => {
    mocks.platform = "android";
    window.localStorage.setItem("instafy.notifications.native_push_token", "legacy-android-token");
    await unregisterNativePushToken(SESSION);
    expect(mocks.remove).toHaveBeenCalledWith({ token: "legacy-android-token", platform: "android", accessToken: SESSION.accessToken });
    expect(mocks.unregister).toHaveBeenCalledOnce();
  });
  it("binds iOS registration to an account and rejects a callback after signout", async () => {
    expect(await ensureNativePushTokenRegistered()).toBe(true);
    mocks.listeners.get("registration")?.({ value: "ios-token" });
    await Promise.resolve();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ token: "ios-token", platform: "ios", accessToken: SESSION.accessToken }));
    expect(window.localStorage.getItem(notificationStorageKey("instafy.notifications.native_push_token"))).toBe("ios-token");
    setNotificationSession(null);
    mocks.listeners.get("registration")?.({ value: "late-token" });
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });
  it("does not attach a delayed old-account token callback to a newly signed-in account", async () => {
    await ensureNativePushTokenRegistered();
    setNotificationSession({ userId: "22222222-2222-4222-8222-222222222222", accessToken: "new-user-token" });
    mocks.listeners.get("registration")?.({ value: "old-account-token" });
    await Promise.resolve();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("serializes an already-started A upsert and cleanup before the same device's B upsert", async () => {
    const writes: string[] = [];
    let owner: string | null = null;
    let finishA: (() => void) | undefined;
    mocks.upsert.mockImplementation(async ({ accessToken }: { accessToken: string }) => {
      if (accessToken === SESSION.accessToken) await new Promise<void>((resolve) => { finishA = resolve; });
      owner = accessToken; writes.push(`upsert:${accessToken}`); return { success: true };
    });
    mocks.remove.mockImplementation(async ({ accessToken }: { accessToken: string }) => {
      if (owner === accessToken) owner = null;
      writes.push(`remove:${accessToken}`); return { success: true };
    });
    const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
    await ensureNativePushTokenRegistered();
    mocks.listeners.get("registration")?.({ value: "same-device-token" });
    await flush();
    expect(finishA).toBeTypeOf("function");
    setNotificationSession({ userId: "22222222-2222-4222-8222-222222222222", accessToken: "new-user-token" });
    const removingA = unregisterNativePushToken(SESSION);
    await flush();
    expect(mocks.unregister).toHaveBeenCalledOnce();
    await ensureNativePushTokenRegistered();
    mocks.listeners.get("registration")?.({ value: "same-device-token" });
    await flush();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    finishA?.(); await removingA; await flush();
    expect(owner).toBe("new-user-token");
    expect(writes.at(-1)).toBe("upsert:new-user-token");
    expect(writes.indexOf("remove:old-user-token")).toBeLessThan(writes.indexOf("upsert:new-user-token"));
  });

});
