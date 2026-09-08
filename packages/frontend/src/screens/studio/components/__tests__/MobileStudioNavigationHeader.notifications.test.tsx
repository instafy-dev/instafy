// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileStudioNavigationHeader } from "../MobileStudioNavigationHeader";
import { useNotificationCenter } from "../../../../notifications/useNotificationCenter";

const mocks = vi.hoisted(() => ({ list: vi.fn(), getPreferences: vi.fn(), show: vi.fn(), hide: vi.fn(), nativeBack: vi.fn(), navigate: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { notifications: {
  list: mocks.list, getPreferences: mocks.getPreferences,
} } }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.show, hideStatus: mocks.hide }) }));
vi.mock("../../../../notifications/notificationPresentation", () => ({ NOTIFICATION_RECEIVED_EVENT: "instafy:notification-received", claimNotificationPresentation: async () => true }));
vi.mock("../../../../notifications/assistantMessageNotifications", () => ({ areMessageNotificationsEnabled: () => false, enableMessageNotifications: vi.fn(), isAppInForeground: () => false, notifyAssistantMessage: vi.fn() }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("mobile header with the real notification center owner", () => {
  let root: Root;
  let container: HTMLDivElement;
  function Harness({ userId = USER }: { userId?: string }) {
    const center = useNotificationCenter({ userId, accessToken: "inert-local-fixture", navigate: mocks.navigate });
    return <>
      <MobileStudioNavigationHeader key={userId} title="Chat" spaceName="Space"
        history={{ canGoBack: true, canGoForward: false, goBack: vi.fn(), goForward: vi.fn() }}
        onOpenPicker={vi.fn()} onOpenChats={vi.fn()} notificationBell={center.bell} />
      {center.dialog}
    </>;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0, asOf: "2026-09-08T00:00:00Z" });
    mocks.getPreferences.mockResolvedValue({ hidePreviews: true, preferences: [] });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); document.body.replaceChildren();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const button = (id: string) => {
    const node = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(node).not.toBeNull(); return node!;
  };

  it.each(["pointer", "virtual"])("opens the actual external notification dialog after a %s press, with More closed", async mode => {
    await act(async () => root.render(<Harness />));
    await act(async () => button("mobile-header-more").click());
    const bell = button("notification-center-bell");
    if (mode === "pointer") {
      // React Aria uses its real pressed-state path after mousedown. A bare
      // .click() has detail0 and instead takes its virtual activation path.
      await act(async () => bell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 })));
      await act(async () => bell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 })));
      await act(async () => bell.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 })));
    } else {
      await act(async () => bell.click());
    }
    expect(button("mobile-header-more").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-testid="notification-center"] [role="dialog"][aria-label="Notifications"]')).not.toBeNull();
    expect(document.body.textContent).toContain("No notifications yet.");
    await act(async () => root.render(<Harness userId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />));
    expect(document.querySelector('[data-testid="notification-center"]')).toBeNull();
  });

  it("dismisses the actual notification dialog with native Back without navigating the workspace", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => button("mobile-header-more").click());
    await act(async () => button("notification-center-bell").click());
    expect(document.querySelector('[data-testid="notification-center"]')).not.toBeNull();
    const lastEnabled = mocks.nativeBack.mock.calls.filter(([enabled]) => enabled).at(-1);
    expect(lastEnabled).toBeDefined();
    await act(async () => lastEnabled![1]());
    expect(document.querySelector('[data-testid="notification-center"]')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
