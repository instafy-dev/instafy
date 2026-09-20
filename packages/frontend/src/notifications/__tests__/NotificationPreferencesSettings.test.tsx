// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationPreferences } from "../notificationContract";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), enableDevice: vi.fn() }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: { getPreferences: mocks.get, savePreferences: mocks.save } } }));
vi.mock("../assistantMessageNotifications", () => ({ enableMessageNotifications: mocks.enableDevice }));
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
  function checkbox(name: string) {
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
    expect(container.querySelectorAll("fieldset")).toHaveLength(4);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(13);
    for (const category of ["Support", "Conversations", "Runs", "Automations"]) {
      for (const channel of ["Browser push", "iPhone push", "In-app and desktop alerts"]) {
        expect(checkbox(`${category} ${channel}`).checked).toBe(true);
      }
    }
    expect(checkbox("Hide lock-screen previews").checked).toBe(true);
    expect(container.textContent).toContain("Activity stays available in Home when alerts are off.");
  });

  it("saves only the changed category/channel and notifies the presenter for that account", async () => {
    await render();
    await act(async () => checkbox("Conversations Browser push").click());
    expect(mocks.save).toHaveBeenCalledWith({ accessToken: `token-${A}`, preferences: [{ category: "conversations", channel: "web_push", enabled: false }] });
    expect(checkbox("Conversations Browser push").checked).toBe(false);
    expect(checkbox("Support Browser push").checked).toBe(true);
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
    expect(checkbox("Hide lock-screen previews").checked).toBe(false);
  });

  it("saves preview privacy without replacing channel preferences", async () => {
    await render();
    await act(async () => checkbox("Hide lock-screen previews").click());
    expect(mocks.save).toHaveBeenCalledWith({ accessToken: `token-${A}`, hidePreviews: false });
    expect(checkbox("Hide lock-screen previews").checked).toBe(false);
  });

  it("serializes changes and leaves the saved value intact when a save fails", async () => {
    const saving = deferred<NotificationPreferences>();
    mocks.save.mockReturnValueOnce(saving.promise);
    await render();
    const input = checkbox("Support Browser push");
    await act(async () => { input.click(); input.click(); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true);
    await act(async () => saving.resolve({ ...initial, preferences: [{ category: "support", channel: "web_push", enabled: false }] }));
    mocks.save.mockRejectedValueOnce(new Error("Unable to save notification preferences (503)"));
    await act(async () => checkbox("Support Browser push").click());
    expect(checkbox("Support Browser push").checked).toBe(false);
    expect(checkbox("Support Browser push").disabled).toBe(false);
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
    expect(checkbox("Hide lock-screen previews").checked).toBe(true);
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
    expect(checkbox("Hide lock-screen previews").checked).toBe(true);
    expect(mocks.get).toHaveBeenLastCalledWith("new-token");
  });

  it.each(["account", "token", "same-account-return"] as const)("does not apply a delayed save to the view after an %s change, and invalidates only its originating account", async (change) => {
    const saving = deferred<NotificationPreferences>();
    mocks.save.mockReturnValueOnce(saving.promise);
    await render();
    await act(async () => checkbox("Hide lock-screen previews").click());
    if (change === "same-account-return") {
      await render(B); await render(A);
    } else {
      await render(change === "account" ? B : A, "new-token");
    }
    await act(async () => saving.resolve({ hidePreviews: false, preferences: [] }));
    expect(checkbox("Hide lock-screen previews").checked).toBe(true);
    expect(checkbox("Hide lock-screen previews").disabled).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ userId: A });
  });

  it("refreshes the originating account's presenter when a save finishes after leaving Settings", async () => {
    const saving = deferred<NotificationPreferences>();
    mocks.save.mockReturnValueOnce(saving.promise);
    await render();
    await act(async () => checkbox("Hide lock-screen previews").click());
    await act(async () => root.render(null));
    await act(async () => saving.resolve(initial));
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ userId: A });
  });

  it("requires a device permission action and reports denial without changing server preferences", async () => {
    mocks.enableDevice.mockResolvedValueOnce(false);
    await render();
    expect(mocks.enableDevice).not.toHaveBeenCalled();
    await clickButton("Enable alerts on this device");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("permission was not granted");
    expect(mocks.save).not.toHaveBeenCalled();
    await clickButton("Enable alerts on this device");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Alerts are enabled on this device.");
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not show another account's delayed device permission result", async () => {
    const enabling = deferred<boolean>();
    mocks.enableDevice.mockReturnValueOnce(enabling.promise);
    await render();
    await clickButton("Enable alerts on this device");
    await render(B);
    await act(async () => enabling.resolve(true));
    expect(container.textContent).not.toContain("Alerts are enabled on this device.");
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
    expect(checkbox("Hide lock-screen previews").checked).toBe(true);
  });
});
