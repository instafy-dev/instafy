// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: vi.fn(), platform: vi.fn(), enabled: vi.fn(), check: vi.fn(), request: vi.fn(), register: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.native, getPlatform: mocks.platform } }));
vi.mock("../assistantMessageNotifications", () => ({ areMessageNotificationsEnabled: mocks.enabled }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: { checkPermissions: mocks.check, requestPermissions: mocks.request, register: mocks.register } }));
import { getNotificationDeviceContext, readNotificationDeviceState } from "../notificationDeviceSettings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native.mockReturnValue(false);
  mocks.platform.mockReturnValue("web");
  mocks.enabled.mockReturnValue(false);
  mocks.check.mockResolvedValue({ receive: "granted" });
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
  delete window.instafyDesktop;
});
afterEach(() => {
  delete window.instafyDesktop;
  vi.unstubAllGlobals();
});

describe("notification device settings", () => {
  it("chooses supported channels for browser, iOS, Android and Desktop", () => {
    expect(getNotificationDeviceContext()).toEqual({ kind: "browser", channel: "web_push" });
    mocks.native.mockReturnValue(true);
    mocks.platform.mockReturnValue("ios");
    expect(getNotificationDeviceContext()).toEqual({ kind: "ios", channel: "apns" });
    mocks.platform.mockReturnValue("android");
    expect(getNotificationDeviceContext()).toEqual({ kind: "android", channel: "local" });
    mocks.native.mockReturnValue(false);
    Object.defineProperty(window, "instafyDesktop", { configurable: true, value: { notify: vi.fn() } });
    expect(getNotificationDeviceContext()).toEqual({ kind: "desktop", channel: "local" });
  });

  it.each(["granted", "denied", "default"] as const)("reads browser permission %s without prompting or registering", async (permission) => {
    vi.stubGlobal("Notification", { permission, requestPermission: vi.fn() });
    expect(await readNotificationDeviceState("browser")).toEqual({ permission: permission === "default" ? "prompt" : permission, enabledForAccount: false });
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("does not mistake unsupported browser alerts or Android push for enabled delivery", async () => {
    Reflect.deleteProperty(window, "Notification");
    mocks.enabled.mockReturnValue(true);
    expect((await readNotificationDeviceState("browser")).permission).toBe("unsupported");
    expect((await readNotificationDeviceState("android")).permission).toBe("unsupported");
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("checks iOS permission without requesting it and reports unknown on failure", async () => {
    expect(await readNotificationDeviceState("ios")).toEqual({ permission: "granted", enabledForAccount: false });
    mocks.check.mockRejectedValueOnce(new Error("unavailable"));
    expect((await readNotificationDeviceState("ios")).permission).toBe("unknown");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("does not claim to inspect Desktop OS permission", async () => {
    mocks.enabled.mockReturnValue(true);
    expect(await readNotificationDeviceState("desktop")).toEqual({ permission: "system", enabledForAccount: true });
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
