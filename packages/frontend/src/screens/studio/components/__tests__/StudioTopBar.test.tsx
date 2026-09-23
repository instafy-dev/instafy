// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTabsProps } from "../../../../workspace/WorkspaceTabs";
import { StudioTopBar } from "../StudioTopBar";

const mocks = vi.hoisted(() => ({
  toggleSidebar: vi.fn(),
  keepTabOpen: vi.fn(),
  startNewConversation: vi.fn(),
  openHome: vi.fn(),
  openTeamSwitcher: vi.fn(),
  navigateBack: vi.fn(),
  openProfileSettings: vi.fn(),
  openConversationTab: vi.fn(),
  requestUrlPush: vi.fn(),
  focusTab: vi.fn(),
  closeTab: vi.fn(),
  navigationPage: "workspace" as "home" | "team" | "account" | "workspace",
  activeTeamName: "My team",
  activeTeamAvatarUrl: null as string | null,
  sidebarCollapsed: false,
  titleBarFree: false,
  profile: { fullName: "Alex Morgan", avatarUrl: null as string | null },
  conversations: [{ localId: "conversation-1", title: "Draft chat" }] as { localId: string; title: string; controllerId?: string; parentConversationId?: string }[],
  isLargeScreen: false,
  showChatActions: false,
  hasTabs: true,
  controllerProjectMissing: false,
  projectAccessBlocked: false,
  tab: { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Draft chat" } as Record<string, string | boolean | undefined>,
}));
vi.mock("../../workspaceControls", () => ({
  useWorkspaceControls: () => ({
    activeProjectName: "My space",
    onToggleSidebar: mocks.toggleSidebar,
    sidebarOpen: false,
    sidebarCollapsed: mocks.sidebarCollapsed,
    onStartNewConversation: mocks.startNewConversation,
    showChatActions: mocks.showChatActions,
    navigationPage: mocks.navigationPage,
    activeTeamName: mocks.activeTeamName,
    activeTeamAvatarUrl: mocks.activeTeamAvatarUrl,
    onOpenHome: mocks.openHome,
    onOpenTeamSwitcher: mocks.openTeamSwitcher,
    onNavigateBack: mocks.navigateBack,
    onOpenProfileSettings: mocks.openProfileSettings,
    userEmail: "alex@example.test",
  }),
}));
vi.mock("../../../../profile/ProfileProvider", () => ({ useProfile: () => ({ profile: mocks.profile }) }));
vi.mock("../../../../lib/desktopShell", () => ({ desktopTitleBarFree: () => mocks.titleBarFree, isDesktopShell: () => false }));
vi.mock("../../useStudioNavigationPosture", () => ({
  useStudioNavigationPosture: () => ({ isLargeScreen: mocks.isLargeScreen, showComposerNavigationButton: !mocks.isLargeScreen }),
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: "project-1" }) }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "test-user" } }) }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ projectAccessBlocked: mocks.projectAccessBlocked }) }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runtime: { controllerProjectMissing: mocks.controllerProjectMissing } }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    tabs: mocks.hasTabs ? [mocks.tab] : [],
    activeTabId: mocks.hasTabs ? mocks.tab.id : null,
    focusTab: mocks.focusTab,
    closeTab: mocks.closeTab,
    keepTabOpen: mocks.keepTabOpen,
    requestUrlPush: mocks.requestUrlPush,
    openConversationTab: mocks.openConversationTab,
  }),
}));
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ conversations: mocks.conversations }),
}));
vi.mock("../StudioNewChatButton", () => ({
  StudioNewChatButton: ({ testId }: { testId?: string }) => <button data-testid={testId} aria-label="New chat" />,
}));
vi.mock("../../../../workspace/WorkspaceTabs", () => ({
  WorkspaceTabs: ({ leading, emptyStateContent, tabStripActions, actions, titleBarInset, flushStart }: WorkspaceTabsProps) => (
    <div data-testid="workspace-tabs" data-titlebar-inset={titleBarInset} data-flush-start={flushStart}>{leading}{emptyStateContent}{tabStripActions}{actions}</div>
  ),
}));
// A ready release must not add an acquisition action back into navigation.
vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({
  useDesktopReleaseLookup: () => ({ lookup: { status: "available", manifest: { version: "0.2.0" } } }),
}));

describe("StudioTopBar navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isLargeScreen = false;
    mocks.showChatActions = false;
    mocks.hasTabs = true;
    mocks.controllerProjectMissing = false;
    mocks.projectAccessBlocked = false;
    mocks.navigationPage = "workspace";
    mocks.sidebarCollapsed = false;
    mocks.titleBarFree = false;
    mocks.activeTeamName = "My team";
    mocks.activeTeamAvatarUrl = null;
    mocks.profile = { fullName: "Alex Morgan", avatarUrl: null };
    mocks.tab = { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Draft chat" };
    mocks.conversations = [{ localId: "conversation-1", title: "Draft chat" }];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("embeds desktop tabs without nesting headers or repeating the native inset", async () => {
    mocks.isLargeScreen = true;
    mocks.titleBarFree = true;
    await act(async () => root.render(<StudioTopBar inlineDesktop newChatInSidebar />));
    const tabs = container.querySelector('[data-testid="workspace-tabs"]')!;
    expect(tabs.getAttribute("data-titlebar-inset")).toBe("false");
    expect(tabs.getAttribute("data-flush-start")).toBe("false");
    expect(tabs.closest('[role="navigation"]')).not.toBeNull();
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector('[data-testid="chat-new-conversation"]')).toBeNull();
  });

  it.each([
    { kind: "conversation", id: "conversation-1", conversationId: "conversation-1", title: "Draft chat" },
    { kind: "panel", id: "home", panel: "home", title: "Home" },
    { kind: "panel", id: "code", panel: "code", title: "Files" },
  ])("keeps sidebar access in $title even when the composer is absent or hidden", async (tab) => {
    mocks.tab = tab as Record<string, string | undefined>;
    await act(async () => root.render(<StudioTopBar />));
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="topbar-sidebar-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toBe(`My space${tab.title}`);
    expect(toggle?.getAttribute("aria-label")).toBe("Open space navigation: My space");
    await act(async () => toggle?.click());
    expect(mocks.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="topbar-home-button"]')).toBeNull();
  });

  it("offers Keep open in the narrow tab switcher without changing the main chat title", async () => {
    mocks.tab = { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Preview chat", preview: true };
    await act(async () => root.render(<StudioTopBar />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="topbar-tab-selector"]');
    const navigation = container.querySelector('[data-testid="topbar-sidebar-toggle"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Browse tabs");
    expect(navigation?.textContent).toBe("My spacePreview chat");
    expect(navigation?.querySelector(".italic")).toBeNull();
    await act(async () => trigger?.click());
    const keepOpen = document.querySelector<HTMLButtonElement>('[data-testid="topbar-tab-keep-open-conversation-1"]');
    expect(keepOpen?.getAttribute("aria-label")).toBe("Keep Preview chat open");
    expect(keepOpen?.title).toBe("Keep open");
    await act(async () => keepOpen?.click());
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("conversation-1");

    mocks.tab = { ...mocks.tab, preview: false };
    await act(async () => root.render(<StudioTopBar />));
    expect(document.querySelector('[data-testid="topbar-tab-keep-open-conversation-1"]')).toBeNull();
  });

  it.each(["home", "team", "account"] as const)("uses Home, the regular navigation drawer and profile for narrow %s navigation", async (navigationPage) => {
    mocks.navigationPage = navigationPage;
    // Global navigation must not derive the team selector from the current tab.
    mocks.tab = { id: "home", kind: "panel", panel: "home", title: "Home" };
    mocks.showChatActions = true;
    await act(async () => root.render(<StudioTopBar />));
    const row = container.querySelector('[data-testid="topbar-global-navigation"]');
    const home = row?.querySelector<HTMLButtonElement>('[data-testid="topbar-home-button"]');
    const team = row?.querySelector<HTMLButtonElement>('[data-testid="topbar-team-selector"]');
    const profile = row?.querySelector<HTMLButtonElement>('[data-testid="topbar-profile-button"]');
    expect(home?.nextElementSibling).toBe(team);
    expect(home?.getAttribute("aria-label")).toBe("Home — all teams");
    expect(home?.title).toBe("Home — all teams");
    expect(home?.getAttribute("aria-current")).toBe(navigationPage === "home" ? "page" : null);
    expect(team?.querySelector('[data-testid="topbar-team-name"]')?.textContent).toBe("My team");
    expect(team?.querySelector('[data-testid="topbar-team-avatar"]')?.textContent).toBe("MT");
    expect(team?.getAttribute("aria-label")).toBe("Open navigation: My team");
    expect(team?.getAttribute("aria-expanded")).toBe("false");
    expect(profile?.getAttribute("aria-current")).toBe(navigationPage === "account" ? "page" : null);
    expect(profile?.textContent).toBe("AM");
    expect(container.querySelector('[data-testid="topbar-workspace-navigation"]')).toBeNull();
    expect(container.querySelector('[aria-label="New chat"]')).toBeNull();
    await act(async () => { home?.click(); team?.click(); profile?.click(); });
    expect(mocks.openHome).toHaveBeenCalledOnce();
    expect(mocks.openTeamSwitcher).not.toHaveBeenCalled();
    expect(mocks.openProfileSettings).toHaveBeenCalledOnce();
    expect(mocks.toggleSidebar).toHaveBeenCalledOnce();
  });

  it("shows the profile avatar in global navigation with a labeled button", async () => {
    mocks.navigationPage = "account";
    mocks.profile.avatarUrl = "https://example.test/avatar.png";
    await act(async () => root.render(<StudioTopBar />));
    const button = container.querySelector('[data-testid="topbar-profile-button"]');
    expect(button?.getAttribute("aria-label")).toBe("Open profile settings");
    expect(button?.querySelector("img")?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button?.querySelector("img")?.alt).toBe("");
  });

  it("uses the selected team's picture independently of the account picture and clears it when switching teams", async () => {
    mocks.navigationPage = "home";
    mocks.activeTeamAvatarUrl = "https://example.test/team.png";
    mocks.profile.avatarUrl = "https://example.test/account.png";
    await act(async () => root.render(<StudioTopBar />));
    const team = container.querySelector('[data-testid="topbar-team-selector"]');
    const avatar = team?.querySelector("img");
    expect(avatar?.getAttribute("src")).toBe(mocks.activeTeamAvatarUrl);
    expect(avatar?.alt).toBe("");
    expect(team?.getAttribute("aria-label")).toBe("Open navigation: My team");
    expect(container.querySelector('[data-testid="topbar-profile-button"] img')?.getAttribute("src")).toBe(mocks.profile.avatarUrl);

    mocks.activeTeamName = "Research team";
    mocks.activeTeamAvatarUrl = null;
    await act(async () => root.render(<StudioTopBar />));
    expect(team?.querySelector("img")).toBeNull();
    expect(team?.querySelector('[data-testid="topbar-team-avatar"]')?.textContent).toBe("RT");
    expect(team?.getAttribute("aria-label")).toBe("Open navigation: Research team");
  });

  it("goes back through the supplied navigation callback in a workspace", async () => {
    await act(async () => root.render(<StudioTopBar />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="topbar-back-button"]')?.click());
    expect(mocks.navigateBack).toHaveBeenCalledOnce();
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
  });

  it("keeps parent navigation separate from the workspace back callback", async () => {
    mocks.conversations = [
      { localId: "conversation-1", title: "Child chat", parentConversationId: "parent-controller" },
      { localId: "parent-local", controllerId: "parent-controller", title: "Parent chat" },
    ];
    await act(async () => root.render(<StudioTopBar />));
    const back = container.querySelector<HTMLButtonElement>('[data-testid="topbar-parent-conversation-button"]');
    expect(back?.getAttribute("aria-label")).toBe("Open parent conversation: Parent chat");
    expect(container.querySelector('[data-testid="topbar-back-button"]')).not.toBeNull();
    await act(async () => back?.click());
    expect(mocks.requestUrlPush).toHaveBeenCalledOnce();
    expect(mocks.openConversationTab).toHaveBeenCalledWith("parent-local");
    expect(mocks.navigateBack).not.toHaveBeenCalled();
  });

  it("keeps space navigation and Back reachable when project access is blocked", async () => {
    mocks.projectAccessBlocked = true;
    await act(async () => root.render(<StudioTopBar />));
    expect(container.querySelector('[data-testid="topbar-sidebar-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="topbar-back-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="topbar-tab-selector"]')).toBeNull();
  });

  it.each([
    { posture: "with tabs", hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false, navigationPage: "workspace" as const },
    { posture: "without tabs", hasTabs: false, controllerProjectMissing: false, projectAccessBlocked: false, navigationPage: "workspace" as const },
    { posture: "with a missing project", hasTabs: true, controllerProjectMissing: true, projectAccessBlocked: false, navigationPage: "workspace" as const },
    { posture: "with blocked project access", hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: true, navigationPage: "workspace" as const },
    { posture: "on the team page", hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false, navigationPage: "team" as const },
  ])("leaves the desktop toggle in the inner rail $posture", async ({ hasTabs, controllerProjectMissing, projectAccessBlocked, navigationPage }) => {
    Object.assign(mocks, { hasTabs, controllerProjectMissing, projectAccessBlocked, navigationPage });
    mocks.isLargeScreen = true;
    await act(async () => root.render(<StudioTopBar />));
    expect(container.querySelector('[data-testid="topbar-sidebar-toggle"]')).toBeNull();

    mocks.sidebarCollapsed = true;
    await act(async () => root.render(<StudioTopBar />));
    expect(container.querySelector('[data-testid="topbar-sidebar-toggle"]')).toBeNull();
  });

  it.each(["home", "account"] as const)("omits the inactive desktop context toggle on %s", async (navigationPage) => {
    mocks.isLargeScreen = true;
    mocks.navigationPage = navigationPage;
    mocks.sidebarCollapsed = true;
    await act(async () => root.render(<StudioTopBar />));
    expect(container.querySelector('[data-testid="topbar-sidebar-toggle"]')).toBeNull();
  });

  it.each([true, false])("preserves safe area and macOS title-bar ownership (integrated=%s)", async (integrated) => {
    mocks.isLargeScreen = true;
    mocks.titleBarFree = integrated;
    await act(async () => root.render(<StudioTopBar />));
    const header = container.querySelector("header")!;
    expect(header.classList.contains("instafy-titlebar-drag")).toBe(integrated);
    expect(header.classList.contains("pt-[var(--instafy-safe-area-inset-top)]")).toBe(!integrated);
  });

  it("keeps wide tab actions focused on New chat and Browse tabs without an install link", async () => {
    mocks.isLargeScreen = true;
    mocks.showChatActions = true;
    mocks.tab = { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Draft chat" };
    await act(async () => root.render(<StudioTopBar />));
    const tabStrip = container.querySelector('[data-testid="workspace-tabs"]');
    const newChat = tabStrip?.querySelector('[data-testid="chat-new-conversation"]');
    const browseTabs = tabStrip?.querySelector<HTMLButtonElement>('[data-testid="topbar-tab-overflow"]');
    expect(newChat?.getAttribute("aria-label")).toBe("New chat");
    expect(browseTabs?.getAttribute("aria-label")).toBe("Browse tabs");
    expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    expect(container.querySelector('a[href^="/install"]')).toBeNull();

    await act(async () => browseTabs?.click());
    const currentTab = document.querySelector('[data-testid="topbar-tab-item-conversation-1"]');
    expect(currentTab?.textContent).toBe("Draft chat");
    expect(currentTab?.getAttribute("aria-current")).toBe("page");
  });

  it.each([
    { posture: "wide with tabs", isLargeScreen: true, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false },
    { posture: "wide without tabs", isLargeScreen: true, hasTabs: false, controllerProjectMissing: false, projectAccessBlocked: false },
    { posture: "wide with a missing project", isLargeScreen: true, hasTabs: true, controllerProjectMissing: true, projectAccessBlocked: false },
    { posture: "wide with blocked project access", isLargeScreen: true, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: true },
    { posture: "mobile", isLargeScreen: false, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false },
    { posture: "mobile Home", isLargeScreen: false, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false, navigationPage: "home" },
    { posture: "mobile team", isLargeScreen: false, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false, navigationPage: "team" },
    { posture: "mobile account", isLargeScreen: false, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false, navigationPage: "account" },
  ])("has no separate notification bell in $posture", async (posture) => {
    Object.assign(mocks, posture);
    await act(async () => root.render(
      <StudioTopBar />,
    ));

    const bells = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Notifications"]');
    expect(bells).toHaveLength(0);
    expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    expect(container.querySelector('a[href^="/install"]')).toBeNull();
  });
});
