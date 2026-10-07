// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationPreferences } from "../notificationContract";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), enableDevice: vi.fn(), disableDevice: vi.fn(), deviceContext: vi.fn(), readDevice: vi.fn() }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: { getPreferences: mocks.get, savePreferences: mocks.save } } }));
vi.mock("../assistantMessageNotifications", () => ({ enableMessageNotifications: mocks.enableDevice, disableMessageNotifications: mocks.disableDevice }));
vi.mock("../notificationDeviceSettings", () => ({ getNotificationDeviceContext: mocks.deviceContext, readNotificationDeviceState: mocks.readDevice }));
import { NotificationPreferencesSettings } from "../NotificationPreferencesSettings";
import { NOTIFICATION_PREFERENCES_CHANGED_EVENT } from "../notificationPreferencesEvents";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const initial: NotificationPreferences = { hidePreviews: true, preferences: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { resolve, promise };
}

describe("notification preferences in Settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  const changed = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(initial);
    mocks.save.mockImplementation(async (patch: Partial<NotificationPreferences>) => ({ ...initial, ...patch }));
    mocks.enableDevice.mockResolvedValue(true);
    mocks.disableDevice.mockResolvedValue(true);
    mocks.deviceContext.mockReturnValue({ kind: "browser", channel: "web_push" });
    mocks.readDevice.mockResolvedValue({ permission: "prompt", enabledForAccount: false });
    window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, changed);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, changed);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(userId: string | null = A, accessToken: string | null = userId ? `token-${userId}` : null) {
    await act(async () => root.render(<NotificationPreferencesSettings userId={userId} accessToken={accessToken} />));
  }
  function toggle(name: string) {
    const input = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((element) => element.getAttribute("aria-label") === name || element.closest("label")?.textContent?.startsWith(name));
    expect(input, name).toBeTruthy();
    return input!;
  }
  async function clickButton(text: string) {
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
    expect(button, text).toBeTruthy();
    await act(async () => button!.click());
  }

  it("loads the current account's preferences and exposes labelled controls for every category and channel", async () => {
    await render();
    expect(mocks.get).toHaveBeenCalledWith(`token-${A}`);
    expect(container.querySelectorAll("fieldset")).toHaveLength(3);
    const disclosure = container.querySelector<HTMLDetailsElement>("details")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('[data-testid="notification-channel-web_push"]')).toBeNull();
    expect(disclosure.querySelector('[data-testid="notification-channel-apns"]')).not.toBeNull();
    expect(disclosure.querySelector('[data-testid="notification-channel-local"]')).not.toBeNull();
    await act(async () => disclosure.querySelector("summary")!.click());
    expect(disclosure.open).toBe(true);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(14);
    for (const category of ["Support", "Conversations", "Runs", "Automations"]) {
      for (const channel of ["Browser push", "iPhone push", "In-app and desktop alerts"]) {
        expect(toggle(`${category} ${channel}`).checked).toBe(true);
      }
    }
    expect(toggle("Hide lock-screen previews").checked).toBe(true);
    expect(container.textContent).toContain("Activity stays available in Home when alerts are off.");
  });

  it.each([
    ["ios", "apns", "iPhone push"],
    ["android", "local", "In-app and desktop alerts"],
    ["desktop", "local", "In-app and desktop alerts"],
  ])("prioritizes the %s channel without removing other account-wide controls", async (kind, channel, label) => {
    mocks.deviceContext.mockReturnValue({ kind, channel });
    await render();
    const main = container.querySelector(`[data-testid="notification-channel-${channel}"]`)!;
    expect(main.closest("details")).toBeNull();
    expect(main.querySelector("legend")?.textContent).toBe(label);
    expect(container.querySelectorAll("details fieldset")).toHaveLength(2);
    await act(async () => toggle(`Support ${label}`).click());
    expect(mocks.save).toHaveBeenCalledWith({ accessToken: `token-${A}`, preferences: [{ category: "support", channel, enabled: false }] });
  });

  it("saves a disclosed channel without changing the primary channel or other saved preferences", async () => {
    const saved: NotificationPreferences = {
      hidePreviews: true,
      preferences: [
        { category: "support", channel: "web_push", enabled: false },
        { category: "runs", channel: "local", enabled: false },
      ],
    };
    mocks.get.mockResolvedValue(saved);
    mocks.save.mockImplementation(async (patch) => ({ ...saved, preferences: [...saved.preferences, ...patch.preferences] }));
    await render();
    await act(async () => container.querySelector("summary")!.click());
    await act(async () => toggle("Conversations iPhone push").click());
    expect(mocks.save).toHaveBeenCalledWith({ accessToken: `token-${A}`, preferences: [{ category: "conversations", channel: "apns", enabled: false }] });
    expect(toggle("Support Browser push").checked).toBe(false);
    expect(toggle("Runs In-app and desktop alerts").checked).toBe(false);
    expect(toggle("Conversations iPhone push").checked).toBe(false);
    expect(toggle("Hide lock-screen previews").checked).toBe(true);
  });

  it("announces automatic saving and uses switches for immediate preferences", async () => {
    await render();
    expect(container.querySelectorAll('input[role="switch"]')).toHaveLength(14);
    expect(container.querySelector('[aria-label="Notification saving status"]')?.textContent).toBe("Changes save automatically.");
  });

  it("saves only the changed category/channel and notifies the presenter for that account", async () => {
    await render();
    await act(async () => toggle("Conversations Browser push").click());
    expect(mocks.save).toHaveBeenCalledWith({ accessToken: `token-${A}`, preferences: [{ category: "conversations", channel: "web_push", enabled: false }] });
    expect(toggle("Conversations Browser push").checked).toBe(false);
    expect(toggle("Support Browser push").checked).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ userId: A });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Notification preferences saved.");
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("reloads matching account invalidations using the current token and ignores other accounts", async () => {
    await render(A, "current-token");
    mocks.get.mockResolvedValue({ hidePreviews: false, preferences: [] });
    await act(async () => window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFERENCES_CHANGED_EVENT, { detail: { userId: B } })));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFERENCES_CHANGED_EVENT, { detail: { userId: A } })));
    expect(mocks.get).toHaveBeenLastCalledWith("current-token");
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(toggle("Hide lock-screen previews").checked).toBe(false);
  });

  it("saves preview privacy without replacing channel preferences", async () => {
    await render();
    await act(async () => toggle("Hide lock-screen previews").click());
    expect(mocks.save).toHaveBeenCalledWith({ accessToken: `token-${A}`, hidePreviews: false });
    expect(toggle("Hide lock-screen previews").checked).toBe(false);
  });

  it("serializes changes and leaves the saved value intact when a save fails", async () => {
    const saving = deferred<NotificationPreferences>();
    mocks.save.mockReturnValueOnce(saving.promise);
    await render();
    const input = toggle("Support Browser push");
    await act(async () => { input.click(); input.click(); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true);
    await act(async () => saving.resolve({ ...initial, preferences: [{ category: "support", channel: "web_push", enabled: false }] }));
    mocks.save.mockRejectedValueOnce(new Error("Unable to save notification preferences (503)"));
    await act(async () => toggle("Support Browser push").click());
    expect(toggle("Support Browser push").checked).toBe(false);
    expect(toggle("Support Browser push").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("503");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shows unavailable preferences without defaulting to editable controls, and retries", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Unable to load notification preferences (404)"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Notification preferences are unavailable on this server.");
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("Loading notification preferences");
    await clickButton("Retry");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(toggle("Hide lock-screen previews").checked).toBe(true);
  });

  it.each(["account", "token"] as const)("hides previous settings and ignores a delayed load after an %s change", async (change) => {
    const old = deferred<NotificationPreferences>();
    const next = deferred<NotificationPreferences>();
    mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await render();
    await render(change === "account" ? B : A, "new-token");
    await act(async () => old.resolve({ hidePreviews: false, preferences: [] }));
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Loading notification preferences");
    await act(async () => next.resolve(initial));
    expect(toggle("Hide lock-screen previews").checked).toBe(true);
    expect(mocks.get).toHaveBeenLastCalledWith("new-token");
  });

  it.each(["account", "token", "same-account-return"] as const)("does not apply a delayed save to the view after an %s change, and invalidates only its originating account", async (change) => {
    const saving = deferred<NotificationPreferences>();
    mocks.save.mockReturnValueOnce(saving.promise);
    await render();
    await act(async () => toggle("Hide lock-screen previews").click());
    if (change === "same-account-return") {
      await render(B); await render(A);
    } else {
      await render(change === "account" ? B : A, "new-token");
    }
    await act(async () => saving.resolve({ hidePreviews: false, preferences: [] }));
    expect(toggle("Hide lock-screen previews").checked).toBe(true);
    expect(toggle("Hide lock-screen previews").disabled).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ userId: A });
  });

  it("refreshes the originating account's presenter when a save finishes after leaving Settings", async () => {
    const saving = deferred<NotificationPreferences>();
    mocks.save.mockReturnValueOnce(saving.promise);
    await render();
    await act(async () => toggle("Hide lock-screen previews").click());
    await act(async () => root.render(null));
    await act(async () => saving.resolve(initial));
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ userId: A });
  });

  it("requires a device permission action and reports denial without changing server preferences", async () => {
    mocks.enableDevice.mockResolvedValueOnce(false);
    await render();
    expect(mocks.enableDevice).not.toHaveBeenCalled();
    await act(async () => toggle("Notifications on this device").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Notifications could not be enabled");
    expect(container.textContent).not.toContain("Updating device alerts");
    expect(container.querySelector('[aria-label="Notification saving status"]')?.textContent).toBe("Changes save automatically.");
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => toggle("Notifications on this device").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Notifications are on for this device.");
    expect(changed).not.toHaveBeenCalled();
  });

  it("clears device progress when permission setup throws", async () => {
    mocks.enableDevice.mockRejectedValueOnce(new Error("Device permission failed."));
    await render();
    await act(async () => toggle("Notifications on this device").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Device permission failed.");
    expect(container.textContent).not.toContain("Updating device alerts");
    expect(container.querySelector('[aria-label="Notification saving status"]')?.textContent).toBe("Changes save automatically.");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("shows granted permission separately from saved category preferences, without requesting it on mount", async () => {
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: true });
    mocks.get.mockResolvedValue({ ...initial, preferences: [{ category: "support", channel: "web_push", enabled: false }] });
    await render();
    expect(toggle("Notifications on this device").checked).toBe(true);
    expect(container.textContent).not.toContain("Enable device alerts");
    expect(toggle("Support Browser push").checked).toBe(false);
    expect(mocks.enableDevice).not.toHaveBeenCalled();
  });

  it("reads permission again after enabling and shows the completed toggle state", async () => {
    await render();
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: true });
    await act(async () => toggle("Notifications on this device").click());
    expect(toggle("Notifications on this device").checked).toBe(true);
    expect(container.textContent).not.toContain("Enable device alerts");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("allows read-only permission rechecks after system settings change", async () => {
    mocks.readDevice.mockResolvedValue({ permission: "denied", enabledForAccount: false });
    await render();
    expect(container.textContent).toContain("blocked in browser settings");
    expect(toggle("Notifications on this device").disabled).toBe(true);
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: false });
    await clickButton("Check permission");
    expect(toggle("Notifications on this device").disabled).toBe(false);
    expect(toggle("Notifications on this device").checked).toBe(false);
    expect(mocks.enableDevice).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not offer unsupported Android push enrollment", async () => {
    mocks.deviceContext.mockReturnValue({ kind: "android", channel: "local" });
    mocks.readDevice.mockResolvedValue({ permission: "unsupported", enabledForAccount: false });
    await render();
    expect(container.textContent).toContain("Push alerts aren't available in the Android app yet");
    expect(toggle("Notifications on this device").disabled).toBe(true);
    expect(container.textContent).not.toContain("Enable device alerts");
    expect(mocks.enableDevice).not.toHaveBeenCalled();
  });

  it("ignores an old account's delayed permission read", async () => {
    const old = deferred<{ permission: "granted"; enabledForAccount: boolean }>();
    mocks.readDevice.mockReturnValueOnce(old.promise);
    await render();
    await render(B);
    await act(async () => old.resolve({ permission: "granted", enabledForAccount: true }));
    expect(container.textContent).not.toContain("Notification permission is granted");
    expect(toggle("Notifications on this device").checked).toBe(false);
  });

  it("does not show another account's delayed device permission result", async () => {
    const enabling = deferred<boolean>();
    mocks.enableDevice.mockReturnValueOnce(enabling.promise);
    await render();
    await act(async () => toggle("Notifications on this device").click());
    await render(B);
    await act(async () => enabling.resolve(true));
    expect(container.textContent).not.toContain("Notifications are on for this device.");
  });

  it("turns device alerts off independently of account-wide preferences", async () => {
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: true });
    await render();
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: false });
    await act(async () => toggle("Notifications on this device").click());
    expect(mocks.disableDevice).toHaveBeenCalledTimes(1);
    expect(mocks.enableDevice).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(toggle("Notifications on this device").checked).toBe(false);
    expect(toggle("Support Browser push").checked).toBe(true);
    expect(container.textContent).toContain("Notifications are off for this device.");
  });

  it.each([false, new Error("Network unavailable")])("keeps alerts locally off and offers retry after push cleanup fails: %s", async (failure) => {
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: true });
    if (failure instanceof Error) mocks.disableDevice.mockRejectedValueOnce(failure);
    else mocks.disableDevice.mockResolvedValueOnce(failure);
    await render();
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: false });
    await act(async () => toggle("Notifications on this device").click());
    expect(toggle("Notifications on this device").checked).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("push delivery could not be disconnected");
    await act(async () => toggle("Hide lock-screen previews").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("push delivery could not be disconnected");
    await act(async () => window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFERENCES_CHANGED_EVENT, { detail: { userId: A } })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("push delivery could not be disconnected");
    await clickButton("Retry turning off");
    expect(mocks.disableDevice).toHaveBeenCalledTimes(2);
    expect(mocks.enableDevice).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Notifications are off for this device.");
  });

  it("waits for setup before selecting the toggle and prevents overlapping changes", async () => {
    const enabling = deferred<boolean>();
    mocks.enableDevice.mockReturnValueOnce(enabling.promise);
    await render();
    await act(async () => toggle("Notifications on this device").click());
    expect(toggle("Notifications on this device").checked).toBe(false);
    expect(toggle("Notifications on this device").disabled).toBe(true);
    expect(toggle("Support Browser push").disabled).toBe(true);
    await act(async () => toggle("Notifications on this device").click());
    expect(mocks.enableDevice).toHaveBeenCalledTimes(1);
    mocks.readDevice.mockResolvedValue({ permission: "granted", enabledForAccount: true });
    await act(async () => enabling.resolve(true));
    expect(toggle("Notifications on this device").checked).toBe(true);
    expect(toggle("Notifications on this device").disabled).toBe(false);
  });

  it("does not fetch without both account and authentication", async () => {
    await render(null);
    await render(A, null);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Sign in");
  });

  it("ignores the abandoned Strict Mode load", async () => {
    const old = deferred<NotificationPreferences>();
    mocks.get.mockReturnValueOnce(old.promise).mockResolvedValue(initial);
    await act(async () => root.render(<StrictMode><NotificationPreferencesSettings userId={A} accessToken={`token-${A}`} /></StrictMode>));
    await act(async () => old.resolve({ hidePreviews: false, preferences: [] }));
    expect(toggle("Hide lock-screen previews").checked).toBe(true);
  });
});
