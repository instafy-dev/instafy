// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: {
  getPreferences: async () => ({ hidePreviews: true, preferences: [] }),
} } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" } }));

import { NotificationPreferencesSettings } from "../NotificationPreferencesSettings";
import { setMessageNotificationsEnabled } from "../assistantMessageNotifications";
import { getNotificationSession, setNotificationSession } from "../notificationSession";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// AuthProvider updates the notification session in a passive effect. Descendant
// Settings effects run first, while the global session still names the old user.
function AuthSessionHarness({ userId }: { userId: string }) {
  useEffect(() => {
    setNotificationSession({ userId, accessToken: `token-${userId}` });
  }, [userId]);
  return <NotificationPreferencesSettings userId={userId} accessToken={`token-${userId}`} />;
}

describe("notification device preferences during account switches", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    vi.stubGlobal("Notification", { permission: "granted" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setNotificationSession(null);
    window.localStorage.clear();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([false, true])("shows the incoming account's saved enabled=%s before its parent updates the session", async (enabled) => {
    setNotificationSession({ userId: B, accessToken: `token-${B}` });
    setMessageNotificationsEnabled(enabled);
    setNotificationSession({ userId: A, accessToken: `token-${A}` });
    setMessageNotificationsEnabled(!enabled);

    const deviceSwitch = () => container.querySelector<HTMLInputElement>('input[aria-label="Notifications on this device"]')!;
    await act(async () => root.render(<AuthSessionHarness userId={A} />));
    expect(deviceSwitch().checked).toBe(!enabled);

    await act(async () => root.render(<AuthSessionHarness userId={B} />));
    expect(getNotificationSession()?.userId).toBe(B);
    expect(deviceSwitch().checked).toBe(enabled);

    await act(async () => root.render(<AuthSessionHarness userId={A} />));
    expect(deviceSwitch().checked).toBe(!enabled);
  });
});
