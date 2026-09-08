// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioTopBar, type StudioTopBarProps } from "../StudioTopBar";

const mocks = vi.hoisted(() => ({
  controls: vi.fn(), projects: vi.fn(), conversations: vi.fn(), tabs: vi.fn(), auth: vi.fn(), posture: vi.fn(),
  projectMembers: vi.fn(), orgMembers: vi.fn(), nativeBack: vi.fn(),
}));
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: mocks.controls }));
vi.mock("../../useStudioNavigationPosture", () => ({ useStudioNavigationPosture: mocks.posture }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: mocks.projects }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ projectAccessBlocked: false }) }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runtime: { controllerProjectMissing: false } }) }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: mocks.auth }));
vi.mock("../../../../conversations/ConversationsProvider", () => ({ useConversations: mocks.conversations }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: mocks.tabs }));
vi.mock("../../../../workspace/WorkspaceTabs", () => ({ WorkspaceTabs: ({ leading, actions, tabStripActions }: { leading: ReactNode; actions: ReactNode; tabStripActions: ReactNode }) => <div data-testid="desktop-workspace-tabs">{leading}{actions}{tabStripActions}</div> }));
vi.mock("../../../../navigation/StudioHistoryControls", () => ({ StudioHistoryControls: () => <span data-testid="desktop-history" />, studioHistoryControlsAvailable: () => true }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));
vi.mock("../../../../lib/desktopShell", () => ({ desktopTitleBarFree: () => false }));
vi.mock("../../../../desktop/voiceTunnel/client", () => ({ desktopSpeechTunnelBridgeAvailable: () => false, readDesktopSpeechTunnelStatus: vi.fn() }));
vi.mock("../../../../desktop/voiceHost/client", () => ({ desktopVoiceHostBridgeAvailable: () => false, readDesktopVoiceHostStatus: vi.fn() }));
vi.mock("../DesktopInstallTopBarAction", () => ({ DesktopInstallTopBarAction: () => null }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { organizations: { listMembers: mocks.orgMembers }, projects: { listMembers: mocks.projectMembers } } }));

describe("StudioTopBar mobile navigation integration", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: StudioTopBarProps;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.controls.mockReturnValue({ activeProjectName: "Alpha space", showChatActions: true, onStartNewConversation: vi.fn(), onStartPrivateConversation: vi.fn(), onToggleSidebar: vi.fn(), onOpenProjectSettings: vi.fn() });
    mocks.projects.mockReturnValue({ activeProjectId: "space-a", projectList: [{ id: "space-a", orgId: "org-a" }] });
    mocks.auth.mockReturnValue({ user: { id: "user-a" } });
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTopbarHomeButton: false, showTouchBottomDock: true });
    mocks.tabs.mockReturnValue({ activeTabId: "tab-a", tabs: [{ id: "tab-a", kind: "conversation", conversationId: "chat-a", title: "Active chat" }], focusTab: vi.fn(), closeTab: vi.fn(), requestUrlPush: vi.fn(), openPanelTab: vi.fn(), openConversationTab: vi.fn() });
    mocks.conversations.mockReturnValue({ conversations: [{ localId: "chat-a", title: "Active chat", parentConversationId: "controller-parent" }, { localId: "parent", controllerId: "controller-parent", title: "Parent chat" }] });
    mocks.orgMembers.mockResolvedValue([]); mocks.projectMembers.mockResolvedValue([]);
    props = { mobileNavigation: { visitKey: "visit-a", history: { canGoBack: false, canGoForward: false, goBack: vi.fn(), goForward: vi.fn() }, onOpenPicker: vi.fn(), onOpenChats: vi.fn() } };
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); document.body.replaceChildren();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const render = () => act(async () => root.render(<StudioTopBar {...props} />));
  const query = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  async function click(testId: string) {
    expect(query(testId)).not.toBeNull(); await act(async () => query(testId)!.click());
  }

  it("uses the active chat and space labels, but respects the full-history title override", async () => {
    await render();
    expect(query("mobile-header-title")?.textContent).toBe("Active chat");
    expect(query("mobile-header-space")?.textContent).toBe("Alpha space");
    await click("mobile-header-picker"); expect(props.mobileNavigation!.onOpenPicker).toHaveBeenCalledTimes(1);
    mocks.controls.mockReturnValue({ ...mocks.controls(), topbarLocationOverride: { title: "Chats" } });
    await render(); expect(query("mobile-header-title")?.textContent).toBe("Chats");
    expect(query("studio-mobile-history-bar")).toBeNull();
  });

  it("dismisses More on every route, account and space scope change in the real owner", async () => {
    await render();
    await click("mobile-header-more"); expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("true");
    props.mobileNavigation = { ...props.mobileNavigation!, visitKey: "visit-b" };
    await render(); expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
    await click("mobile-header-more");
    mocks.auth.mockReturnValue({ user: { id: "user-b" } });
    await render(); expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
    await click("mobile-header-more");
    mocks.projects.mockReturnValue({ ...mocks.projects(), activeProjectId: "space-b" });
    await render(); expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps public creation, the existing private picker and parent navigation behind More", async () => {
    await render(); await click("mobile-header-more"); await click("chat-new-chat-public");
    expect(mocks.controls().onStartNewConversation).toHaveBeenCalledTimes(1);
    await click("mobile-header-more"); await click("topbar-parent-conversation-button");
    expect(mocks.tabs().requestUrlPush).toHaveBeenCalledTimes(1);
    expect(mocks.tabs().openConversationTab).toHaveBeenCalledExactlyOnceWith("parent");
    await click("mobile-header-more"); await click("chat-new-chat-private");
    expect(document.querySelector('[role="dialog"][aria-label="Start private chat"]')).not.toBeNull();
    expect(mocks.projectMembers).toHaveBeenCalledExactlyOnceWith("space-a");
    expect(mocks.controls().onStartPrivateConversation).not.toHaveBeenCalled();
  });

  it("dismisses the private picker on native Back without navigating the conversation", async () => {
    await render(); await click("mobile-header-more");
    mocks.nativeBack.mockClear();
    await click("chat-new-chat-private");
    const dialog = () => document.querySelector('[role="dialog"][aria-label="Start private chat"]');
    expect(dialog()).not.toBeNull();
    const enabled = mocks.nativeBack.mock.calls.filter(([active]) => active).at(-1);
    expect(enabled).toBeDefined();
    await act(async () => enabled![1]());
    expect(dialog()).toBeNull();
    expect(props.mobileNavigation!.history.goBack).not.toHaveBeenCalled();
    expect(mocks.tabs().requestUrlPush).not.toHaveBeenCalled();
    expect(mocks.controls().onStartPrivateConversation).not.toHaveBeenCalled();
    await click("mobile-header-more"); await click("chat-new-chat-private");
    expect(dialog()).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('[data-testid="chat-private-chat-search"]')?.value).toBe("");
  });

  it("dismisses the private picker when the underlying touch visit changes", async () => {
    await render(); await click("mobile-header-more"); await click("chat-new-chat-private");
    expect(document.querySelector('[role="dialog"][aria-label="Start private chat"]')).not.toBeNull();
    props.mobileNavigation = { ...props.mobileNavigation!, visitKey: "visit-b" };
    await render();
    expect(document.querySelector('[role="dialog"][aria-label="Start private chat"]')).toBeNull();
    expect(mocks.controls().onStartPrivateConversation).not.toHaveBeenCalled();
  });

  it("clears the nested tab popover after native Back or a visit change", async () => {
    await render();
    for (const close of ["native", "route"]) {
      await click("mobile-header-more"); await click("topbar-tab-overflow");
      expect(query("topbar-tab-selector-menu")).not.toBeNull();
      if (close === "native") {
        const latestEnabled = mocks.nativeBack.mock.calls.filter(([enabled]) => enabled).at(-1)!;
        await act(async () => latestEnabled[1]());
      } else {
        props.mobileNavigation = { ...props.mobileNavigation!, visitKey: "visit-b" };
        await render();
      }
      expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
      await click("mobile-header-more");
      expect(query("topbar-tab-overflow")?.getAttribute("aria-expanded")).toBe("false");
      expect(query("topbar-tab-selector-menu")).toBeNull();
      await click("mobile-header-more");
    }
  });

  it("preserves desktop tabs and actions even when mobile props are supplied", async () => {
    mocks.posture.mockReturnValue({ isLargeScreen: true, showTopbarHomeButton: false, showTouchBottomDock: false });
    await render();
    expect(query("desktop-workspace-tabs")).not.toBeNull();
    expect(query("desktop-history")).not.toBeNull();
    expect(query("chat-new-conversation")).not.toBeNull();
    expect(query("topbar-parent-conversation-button")).not.toBeNull();
    expect(query("mobile-studio-navigation-header")).toBeNull();
  });

  it("retains the existing non-touch compact header when the posture is not touch", async () => {
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTopbarHomeButton: true, showTouchBottomDock: false });
    await render();
    expect(query("mobile-studio-navigation-header")).toBeNull();
    expect(query("topbar-tab-selector")).not.toBeNull();
    expect(query("topbar-sidebar-toggle")).not.toBeNull();
    expect(query("studio-mobile-history-bar")).not.toBeNull();
  });
});
