// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioTopBar, type StudioTopBarProps } from "../StudioTopBar";
import { StudioSearchReturnProvider } from "../StudioSearchReturnContext";

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
vi.mock("../../../../profile/ProfileProvider", () => ({ useProfile: () => ({ profile: { fullName: "Alex Morgan", avatarUrl: "https://example.test/account.png" } }) }));
vi.mock("../../../../conversations/ConversationsProvider", () => ({ useConversations: mocks.conversations }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: mocks.tabs }));
vi.mock("../../../../workspace/WorkspaceTabs", () => ({ WorkspaceTabs: ({ leading, actions, tabStripActions }: { leading: ReactNode; actions: ReactNode; tabStripActions: ReactNode }) => <div data-testid="desktop-workspace-tabs">{leading}{actions}{tabStripActions}</div> }));
vi.mock("../../../../navigation/StudioHistoryControls", () => ({ StudioHistoryControls: () => <span data-testid="desktop-history" />, studioHistoryControlsAvailable: () => true }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));
vi.mock("../../../../lib/desktopShell", () => ({ desktopTitleBarFree: () => false }));
vi.mock("../../../../desktop/voiceTunnel/client", () => ({ desktopSpeechTunnelBridgeAvailable: () => false, readDesktopSpeechTunnelStatus: vi.fn() }));
vi.mock("../../../../desktop/voiceHost/client", () => ({ desktopVoiceHostBridgeAvailable: () => false, readDesktopVoiceHostStatus: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { organizations: { listMembers: mocks.orgMembers }, projects: { listMembers: mocks.projectMembers } } }));

describe("StudioTopBar mobile navigation integration", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: StudioTopBarProps;
  let originToken: string | null;
  const returnToResults = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    originToken = null;
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
  const render = () => act(async () => root.render(<StudioSearchReturnProvider value={{ originToken, returnToResults }}><StudioTopBar {...props} /></StudioSearchReturnProvider>));
  const query = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  async function click(testId: string) {
    expect(query(testId)).not.toBeNull(); await act(async () => query(testId)!.click());
  }

  it.each([true, false])("shares Results, Back and Chats destinations without duplicate arrows (touch=%s)", async touch => {
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTouchBottomDock: touch });
    props.mobileNavigation!.history.canGoBack = true;
    originToken = "owned-search";
    await render();
    expect(query("mobile-header-results")?.textContent).toBe("Results");
    expect(query("mobile-header-back")).toBeNull();
    expect(query("topbar-back-button")).toBeNull();
    expect(query("mobile-header-open-chats")).toBeNull();
    await click("mobile-header-results");
    expect(returnToResults).toHaveBeenCalledOnce();
    expect(props.mobileNavigation!.history.goBack).not.toHaveBeenCalled();
    expect(props.mobileNavigation!.onOpenChats).not.toHaveBeenCalled();

    originToken = null;
    await render();
    expect(query("mobile-header-results")).toBeNull();
    await click("mobile-header-back");
    expect(props.mobileNavigation!.history.goBack).toHaveBeenCalledOnce();
    expect(props.mobileNavigation!.onOpenChats).not.toHaveBeenCalled();

    props.mobileNavigation!.history.canGoBack = false;
    await render();
    expect(query("mobile-header-back")).toBeNull();
    expect(query("mobile-header-open-chats")?.textContent).toBe("Chats");
    await click("mobile-header-open-chats");
    expect(props.mobileNavigation!.onOpenChats).toHaveBeenCalledOnce();
    expect(props.mobileNavigation!.history.goBack).toHaveBeenCalledOnce();
    expect(returnToResults).toHaveBeenCalledOnce();
  });

  it("uses the active chat and space labels, but respects the full-history title override", async () => {
    mocks.tabs.mockReturnValue({ ...mocks.tabs(), tabs: [{ ...mocks.tabs().tabs[0], icon: <svg data-testid="conversation-icon" /> }] });
    await render();
    expect(query("mobile-header-title")?.textContent).toBe("Active chat");
    expect(query("mobile-header-location-icon")?.contains(query("conversation-icon"))).toBe(true);
    expect(query("mobile-header-space")?.textContent).toBe("Alpha space");
    await click("mobile-header-picker");
    expect(mocks.controls().onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(props.mobileNavigation!.onOpenPicker).not.toHaveBeenCalled();
    expect(query("mobile-header-picker")?.getAttribute("aria-label")).toBe("Open space navigation: Alpha space");
    mocks.controls.mockReturnValue({ ...mocks.controls(), topbarLocationOverride: { title: "Chats", icon: <svg data-testid="chats-icon" /> } });
    await render(); expect(query("mobile-header-title")?.textContent).toBe("Chats");
    expect(query("mobile-header-location-icon")?.contains(query("chats-icon"))).toBe(true);
    expect(query("conversation-icon")).toBeNull();
    expect(query("studio-mobile-history-bar")).toBeNull();
  });

  it.each([true, false])("omits the repeated space label beneath a context header while preserving navigation (touch=%s)", async touch => {
    props.contextHeaderAbove = true;
    props.mobileNavigation!.history.canGoBack = true;
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTopbarHomeButton: false, showTouchBottomDock: touch });
    await render();
    const pickerId = "mobile-header-picker";
    expect(query("mobile-header-title")?.textContent).toBe("Active chat");
    expect(query("mobile-header-title")?.closest("button")).toBeNull();
    expect(query(pickerId)?.getAttribute("aria-label")).toBe("Open space navigation: Alpha space");
    expect(query("mobile-header-space")).toBeNull();
    await click(pickerId);
    expect(mocks.controls().onToggleSidebar).toHaveBeenCalledOnce();

    await click("mobile-header-back");
    expect(props.mobileNavigation!.history.goBack).toHaveBeenCalledOnce();
    expect(query("studio-mobile-history-bar")).toBeNull();
    await click("mobile-header-more");
    expect(query("chat-new-chat-private")).not.toBeNull();
    expect(query("chat-new-chat-public")).not.toBeNull();
    expect(query("topbar-tab-overflow")).not.toBeNull();
  });

  it.each(["home", "team", "account"])("opens the regular navigation drawer on touch %s while keeping Home and profile actions stable", async (navigationPage) => {
    originToken = "owned-search";
    mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage, activeTeamName: "Research team", activeTeamAvatarUrl: "https://example.test/team.png", onOpenHome: vi.fn(), onOpenTeamSwitcher: vi.fn(), onOpenProfileSettings: vi.fn() });
    await render();
    expect(query("mobile-header-results")).toBeNull();
    expect(query("mobile-studio-navigation-header")).toBeNull();
    expect(query("topbar-global-navigation")).not.toBeNull();
    expect(query("topbar-home-button")?.nextElementSibling).toBe(query("topbar-team-selector"));
    expect(query("topbar-home-button")?.getAttribute("aria-current")).toBe(navigationPage === "home" ? "page" : null);
    expect(query("topbar-profile-button")?.getAttribute("aria-current")).toBe(navigationPage === "account" ? "page" : null);
    expect(query("topbar-team-name")?.textContent).toBe("Research team");
    expect(query("topbar-team-selector")?.getAttribute("aria-label")).toBe("Open navigation: Research team");
    expect(query("topbar-team-selector")?.getAttribute("aria-expanded")).toBe("false");
    expect(query("topbar-team-selector")?.querySelector("img")?.getAttribute("src")).toBe("https://example.test/team.png");
    expect(query("topbar-profile-button")?.querySelector("img")?.getAttribute("src")).toBe("https://example.test/account.png");
    for (const id of ["topbar-home-button", "topbar-team-selector", "topbar-profile-button"]) {
      expect(query(id)?.classList.contains("!min-h-12")).toBe(true);
    }
    await click("topbar-home-button"); await click("topbar-team-selector"); await click("topbar-profile-button");
    expect(mocks.controls().onOpenHome).toHaveBeenCalledTimes(1);
    expect(mocks.controls().onOpenTeamSwitcher).not.toHaveBeenCalled();
    expect(mocks.controls().onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(mocks.controls().onOpenProfileSettings).toHaveBeenCalledTimes(1);
    expect(props.mobileNavigation!.onOpenPicker).not.toHaveBeenCalled();
    expect(query("chat-new-conversation")).toBeNull();

    mocks.controls.mockReturnValue({ ...mocks.controls(), sidebarOpen: true });
    await render();
    expect(query("topbar-team-selector")?.getAttribute("aria-expanded")).toBe("true");
    await click("topbar-team-selector");
    expect(mocks.controls().onToggleSidebar).toHaveBeenCalledTimes(2);
    expect(mocks.controls().onOpenTeamSwitcher).not.toHaveBeenCalled();
  });

  it("keeps the team picker fallback available when the shell has no navigation drawer", async () => {
    const onOpenTeamSwitcher = vi.fn();
    mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage: "home", activeTeamName: "Research team", onToggleSidebar: undefined, onOpenTeamSwitcher });
    await render();
    expect(query("topbar-team-selector")?.getAttribute("aria-label")).toBe("Choose team: Research team");
    expect(query("topbar-team-selector")?.disabled).toBe(false);
    await click("topbar-team-selector");
    expect(onOpenTeamSwitcher).toHaveBeenCalledTimes(1);

    mocks.controls.mockReturnValue({ ...mocks.controls(), onOpenTeamSwitcher: undefined });
    await render();
    expect(query("topbar-team-selector")?.disabled).toBe(true);
  });

  it.each(["home", "team", "account"])("uses chronological history on global %s without opening a drawer", async (navigationPage) => {
    mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage, activeTeamName: "Research team", onOpenHome: vi.fn(), onOpenTeamSwitcher: vi.fn(), onOpenProfileSettings: vi.fn() });
    props.mobileNavigation!.history.canGoBack = true;
    props.mobileNavigation!.history.canGoForward = true;
    await render();
    expect(query("topbar-home-button")?.nextElementSibling).toBe(query("topbar-team-selector"));
    expect(query("topbar-history-menu-trigger")?.nextElementSibling).toBe(query("topbar-profile-button"));
    expect(query("topbar-profile-button")?.nextElementSibling).toBeNull();
    expect(query("topbar-history-menu-trigger")?.classList.contains("!min-h-12")).toBe(true);
    await click("topbar-history-menu-trigger");
    expect(query("topbar-history-menu")).not.toBeNull();
    expect(props.mobileNavigation!.onOpenPicker).not.toHaveBeenCalled();
    expect(mocks.controls().onToggleSidebar).not.toHaveBeenCalled();
    await click("topbar-history-forward");
    expect(props.mobileNavigation!.history.goForward).toHaveBeenCalledTimes(1);
    expect(query("topbar-history-menu")).toBeNull();
    await click("topbar-history-menu-trigger"); await click("topbar-history-back");
    expect(props.mobileNavigation!.history.goBack).toHaveBeenCalledTimes(1);
    expect(mocks.controls().onOpenHome).not.toHaveBeenCalled();
    expect(mocks.controls().onOpenTeamSwitcher).not.toHaveBeenCalled();
    expect(mocks.controls().onOpenProfileSettings).not.toHaveBeenCalled();
    expect(mocks.tabs().requestUrlPush).not.toHaveBeenCalled();
  });

  it("hides unknown global history and disables a direction that has no known entry", async () => {
    mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage: "home" });
    await render(); expect(query("topbar-history-menu-trigger")).toBeNull();
    props.mobileNavigation!.history.canGoBack = true;
    await render(); await click("topbar-history-menu-trigger");
    expect(query("topbar-history-back")?.disabled).toBe(false);
    expect(query("topbar-history-forward")?.disabled).toBe(true);
    await click("topbar-history-forward");
    expect(props.mobileNavigation!.history.goForward).not.toHaveBeenCalled();
    expect(query("topbar-history-menu")).not.toBeNull();
  });

  it("dismisses global history on native Back, visit, account, space and posture changes", async () => {
    mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage: "home" });
    props.mobileNavigation!.history.canGoBack = true;
    await render(); await click("topbar-history-menu-trigger");
    const nativeBack = mocks.nativeBack.mock.calls.filter(([active]) => active).at(-1)!;
    await act(async () => nativeBack[1]());
    expect(query("topbar-history-menu")).toBeNull();
    expect(props.mobileNavigation!.history.goBack).not.toHaveBeenCalled();
    const changes = [
      () => { props.mobileNavigation = { ...props.mobileNavigation!, visitKey: "visit-b" }; },
      () => { mocks.auth.mockReturnValue({ user: { id: "user-b" } }); },
      () => { mocks.projects.mockReturnValue({ ...mocks.projects(), activeProjectId: "space-b" }); },
      () => { mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage: "account" }); },
      () => { mocks.posture.mockReturnValue({ isLargeScreen: true, showTouchBottomDock: false }); },
    ];
    for (const change of changes) {
      await click("topbar-history-menu-trigger");
      expect(query("topbar-history-menu")).not.toBeNull();
      change(); await render();
      expect(query("topbar-history-menu")).toBeNull();
    }
    expect(props.mobileNavigation!.history.goBack).not.toHaveBeenCalled();
    expect(props.mobileNavigation!.history.goForward).not.toHaveBeenCalled();
  });

  it("dismisses global history when input posture changes at the same narrow width", async () => {
    mocks.controls.mockReturnValue({ ...mocks.controls(), navigationPage: "home" });
    props.mobileNavigation!.history.canGoBack = true;
    await render(); await click("topbar-history-menu-trigger");
    expect(query("topbar-history-menu")).not.toBeNull();
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTouchBottomDock: false });
    await render();
    expect(query("topbar-history-menu")).toBeNull();
    expect(query("studio-mobile-history-bar")).not.toBeNull();
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTouchBottomDock: true });
    await render();
    expect(query("topbar-history-menu-trigger")?.getAttribute("aria-expanded")).toBe("false");
    expect(query("topbar-history-menu")).toBeNull();
    expect(props.mobileNavigation!.history.goBack).not.toHaveBeenCalled();
  });

  it("keeps chronological Back distinct from opening a parent conversation", async () => {
    props.mobileNavigation!.history.canGoBack = true;
    await render(); await click("mobile-header-back");
    expect(props.mobileNavigation!.history.goBack).toHaveBeenCalledTimes(1);
    expect(mocks.tabs().openConversationTab).not.toHaveBeenCalled();
    await click("mobile-header-more"); await click("topbar-parent-conversation-button");
    expect(mocks.tabs().openConversationTab).toHaveBeenCalledExactlyOnceWith("parent");
    expect(props.mobileNavigation!.history.goBack).toHaveBeenCalledTimes(1);
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

  it("exposes Forward directly in the compact header without an extra native history row", async () => {
    mocks.posture.mockReturnValue({ isLargeScreen: false, showTopbarHomeButton: false, showTouchBottomDock: false });
    await render();
    expect(query("mobile-studio-navigation-header")).not.toBeNull();
    expect(query("studio-mobile-history-bar")).toBeNull();
    expect(query("topbar-home-button")).toBeNull();
    props.mobileNavigation!.history.canGoForward = true;
    await render();
    await click("mobile-header-forward");
    expect(props.mobileNavigation!.history.goForward).toHaveBeenCalledOnce();
    expect(props.mobileNavigation!.history.goBack).not.toHaveBeenCalled();
  });
});
