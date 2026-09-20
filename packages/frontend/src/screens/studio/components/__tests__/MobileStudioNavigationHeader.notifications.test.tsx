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
        onOpenPicker={vi.fn()} onOpenChats={vi.fn()} />
      <span data-testid="notification-data-count">{center.page.items.length}</span>
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

  it("keeps the notification owner active without a second inbox or bell in More", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => button("mobile-header-more").click());
    expect(document.querySelector('[data-testid="notification-center-bell"]')).toBeNull();
    expect(document.querySelector('[data-testid="notification-center"]')).toBeNull();
    expect(mocks.list).toHaveBeenCalled();
    expect(button("mobile-header-more").getAttribute("aria-expanded")).toBe("true");
    const lastEnabled = mocks.nativeBack.mock.calls.filter(([enabled]) => enabled).at(-1);
    expect(lastEnabled).toBeDefined();
    await act(async () => lastEnabled![1]());
    expect(button("mobile-header-more").getAttribute("aria-expanded")).toBe("false");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
