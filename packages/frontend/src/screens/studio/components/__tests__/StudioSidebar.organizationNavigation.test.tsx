// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  projects: [
    { id: "space-a", name: "Core", orgId: "org-a", orgName: "Alpha", state: null, isRemoteOnly: false },
    { id: "space-c", name: "Design", orgId: "org-c", orgName: "Charlie", state: null, isRemoteOnly: false },
  ],
  activeProjectId: "space-a" as string | null,
  homeAttentionCount: 0,
  homeAttentionByProject: {} as Record<string, number>,
  orgs: [
    { id: "org-a", name: "Alpha", slug: "alpha", role: "builder", avatarUrl: null as string | null },
    { id: "org-b", name: "Empty team", slug: "empty", role: "owner", avatarUrl: null as string | null },
    { id: "org-c", name: "Charlie", slug: "charlie", role: "builder", avatarUrl: null as string | null },
  ],
  userEmail: "member@example.test",
  desktop: true,
  touchLikeInput: false,
  settingsAvailable: true,
  showChatActions: true,
  newChatAvailable: true,
  navigationPage: "workspace" as "home" | "team" | "account" | "workspace",
  onStartNewConversation: vi.fn(),
  onStartPrivateConversation: vi.fn(),
  privateChatAvailable: false,
  onToggleSidebar: vi.fn(),
  switchProject: vi.fn(), createProject: vi.fn(), onSettings: vi.fn(), onNewSpace: vi.fn(),
  copyTunnelDetails: vi.fn(), showStatus: vi.fn(), refresh: vi.fn(), retry: vi.fn(),
  discoveryError: null as string | null, discoveryResolved: true, discoveryRefreshing: false,
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({
  projectList: fixture.projects, activeProjectId: fixture.activeProjectId, switchProject: fixture.switchProject, createProject: fixture.createProject,
}) }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: ({ orgId }: { orgId: string | null }) => ({
  mergedProjects: fixture.projects, remoteLoading: false, remoteLoadedScope: fixture.discoveryResolved ? orgId : null,
  remoteDiscoveryResolved: fixture.discoveryResolved, remoteError: fixture.discoveryError,
  remoteRefreshing: fixture.discoveryRefreshing, retryRemoteProjects: fixture.retry,
}) }));
vi.mock("../../../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../../../sdk/instafy")>("../../../../sdk/instafy");
  return { ...actual, runtimeControllerEnabled: true, controllerClient: {
    ...actual.controllerClient,
    organizations: { ...actual.controllerClient.organizations, list: async () => fixture.orgs, listMembers: async () => [] },
    projects: { ...actual.controllerClient.projects, listMembers: async () => [{ userId: "teammate-id", fullName: "Teammate", email: "teammate@example.test" }] },
  } };
});
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({
  userEmail: fixture.userEmail, hasLogs: false, sidebarOpen: true,
  homeAttentionCount: fixture.homeAttentionCount,
  homeAttentionByProject: fixture.homeAttentionByProject,
  onOpenOrgSettings: fixture.settingsAvailable ? fixture.onSettings : undefined, onStartNewProject: fixture.onNewSpace,
  onToggleSidebar: fixture.onToggleSidebar,
  showChatActions: fixture.showChatActions,
  navigationPage: fixture.navigationPage,
  onStartNewConversation: fixture.newChatAvailable ? fixture.onStartNewConversation : undefined,
  onStartPrivateConversation: fixture.privateChatAvailable ? fixture.onStartPrivateConversation : undefined,
}) }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "member-id", email: fixture.userEmail } }) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => fixture.desktop }));
vi.mock("../../../../hooks/useTouchLikeInput", () => ({ useTouchLikeInput: () => fixture.touchLikeInput }));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({ useRuntimeMenuOptions: () => ({
  runtime: { copyTunnelDetails: fixture.copyTunnelDetails }, runtimeOptions: [],
}) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: fixture.showStatus }) }));
vi.mock("../../../../profile/ProfileProvider", () => ({ useProfile: () => ({ profile: { fullName: "Member" } }) }));
vi.mock("../../../../theme/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light", setThemeMode: fixture.refresh }) }));
vi.mock("../../../../debug/useAppLogs", () => ({ useAppLogs: () => ({ logs: [], hasLogs: false, hasErrors: false, clearLogs: fixture.refresh }) }));
vi.mock("../../../../updates/useAppUpdateMetadata", () => ({ useAppUpdateMetadata: () => ({ metadata: null, refresh: fixture.refresh }) }));
vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({ useDesktopReleaseLookup: () => ({ lookup: { status: "unavailable" } }) }));

import { StudioSidebar } from "../StudioSidebar";
import { StudioSearchContext } from "../StudioSearchContext";
import { useStudioSearch } from "../useStudioSearch";
import { recordProjectOpened } from "../../../../projects/projectRecency";
import { usesGlobalNavigationContext } from "../../teamNavigation";

describe("StudioSidebar organization navigation", () => {
  let container: HTMLDivElement;
  let portal: HTMLDivElement;
  let headerPortal: HTMLDivElement;
  let root: Root;
  const onOpenTeam = vi.fn();
  const onReturnToTeam = vi.fn();
  const onActivateProject = vi.fn();
  const onSwitcherChange = vi.fn();
  const onSelect = vi.fn();
  const onRequestClose = vi.fn();
  const render = async (props: Partial<ComponentProps<typeof StudioSidebar>> = {}) => {
    await act(async () => root.render(<BrowserRouter><StudioSidebar
      items={[{ id: "chat", label: "Chats", icon: () => <span />, accent: "text-primary-600" }]}
      activePanel="chat" onSelect={onSelect} collapsed={false}
      workspaceSwitcherOpen={false} onWorkspaceSwitcherOpenChange={onSwitcherChange}
      workspaceSwitcherPortalTarget={portal} onOpenTeam={onOpenTeam}
      onReturnToTeam={onReturnToTeam} onActivateProject={onActivateProject}
      onRequestClose={onRequestClose} {...props} /></BrowserRouter>));
  };
  const click = async (testId: string) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect(element).not.toBeNull();
    await act(async () => element!.click());
  };
  const chooseTeamAction = async (action: "overview" | "settings" | "switch") => {
    await click("sidebar-team-menu-trigger");
    if (fixture.desktop) await click(`sidebar-team-menu-${action}`);
    else if (action !== "switch") await click(`sidebar-org-${action}-button`);
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
  };
  it("routes rail context actions to the clicked team without switching its space first", async () => {
    await render({ navigationPresentation: "path", navigationHeaderExternal: true });
    const open = async () => {
      await act(async () => document.querySelector('[data-testid="sidebar-team-org-b"]')!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    };
    await open(); await click("sidebar-org-context-settings");
    expect(fixture.onSettings).toHaveBeenLastCalledWith("org-b", "profile");
    await open(); await click("sidebar-org-context-members");
    expect(fixture.onSettings).toHaveBeenLastCalledWith("org-b", "members");
    await open(); await click("sidebar-org-context-overview");
    expect(onOpenTeam).toHaveBeenLastCalledWith("org-b");
    expect(fixture.switchProject).not.toHaveBeenCalled();
    expect(onActivateProject).not.toHaveBeenCalled();
  });
  const secondaryNavigationProps = (): Partial<ComponentProps<typeof StudioSidebar>> => ({
    mobileOverlay: true,
    navigationHeaderExternal: true,
    onSelectConversation: vi.fn(),
    items: [
      { id: "chat", label: "Chats" }, { id: "automations", label: "Automations" },
      { id: "code", label: "Files" }, { id: "sourceControl", label: "Changes" },
    ].map(item => ({ ...item, icon: () => <span />, accent: "" })) as ComponentProps<typeof StudioSidebar>["items"],
    moreItems: [
      { id: "extensions", label: "Extensions" }, { id: "secrets", label: "Secrets" },
      { id: "skills", label: "Skills" }, { id: "ai", label: "Your AI" },
      { id: "machines", label: "Machines" }, { id: "credits", label: "Credits" },
    ].map(item => ({ ...item, icon: () => <span />, accent: "" })) as ComponentProps<typeof StudioSidebar>["moreItems"],
  });
  const mockSidebarHeight = (initialHeight: number) => {
    let height = initialHeight;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 352, this.dataset.testid === "sidebar-context-navigation" ? height : 72);
    });
    return async (nextHeight: number) => {
      height = nextHeight;
      await act(async () => window.dispatchEvent(new Event("resize")));
    };
  };
  const visibleSecondaryIds = (scope: ParentNode = container) =>
    Array.from(scope.querySelectorAll('[data-testid^="sidebar-more-item-"]'), item =>
      item.getAttribute("data-testid")!.replace("sidebar-more-item-", ""));
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.clearAllMocks();
    // JSDOM lacks CSS.escape, which React Aria uses for keyboard menu focus.
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    fixture.userEmail = "member@example.test";
    fixture.desktop = true;
    fixture.touchLikeInput = false;
    fixture.settingsAvailable = true;
    fixture.showChatActions = true;
    fixture.newChatAvailable = true;
    fixture.privateChatAvailable = false;
    fixture.navigationPage = "workspace";
    fixture.activeProjectId = "space-a";
    fixture.homeAttentionCount = 0;
    fixture.homeAttentionByProject = {};
    fixture.projects = [
      { id: "space-a", name: "Core", orgId: "org-a", orgName: "Alpha", state: null, isRemoteOnly: false },
      { id: "space-c", name: "Design", orgId: "org-c", orgName: "Charlie", state: null, isRemoteOnly: false },
    ];
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: null }));
    fixture.discoveryError = null;
    fixture.discoveryResolved = true;
    fixture.discoveryRefreshing = false;
    container = document.createElement("div");
    portal = document.createElement("div");
    headerPortal = document.createElement("div");
    document.body.append(container, portal, headerPortal);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portal.remove();
    headerPortal.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["home", "space-a"],
    ["home", null],
    ["account", null],
  ] as const)("keeps the global rail and account while %s with active space %s hides context", async (page, projectId) => {
    fixture.navigationPage = page;
    fixture.activeProjectId = projectId;
    await render({ activePanel: page === "home" ? "home" : "settings", hideContext: usesGlobalNavigationContext(page, projectId) });
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="sidebar-profile-menu"]')).toHaveLength(1);
  });

  it.each([false, true])("retains the active space's sidebar and context controls when opening personal Settings (collapsed=%s)", async (collapsed) => {
    await render({ collapsed, navigationHeaderPortalTarget: headerPortal });
    const navigation = container.querySelector('[data-testid="sidebar-context-navigation"]');
    const toggle = container.querySelector('[data-testid="sidebar-drawer-toggle"]');
    expect(navigation).not.toBeNull();
    expect(toggle).not.toBeNull();
    fixture.navigationPage = "account";
    await render({
      activePanel: "settings", collapsed, navigationHeaderPortalTarget: headerPortal,
      hideContext: usesGlobalNavigationContext(fixture.navigationPage, fixture.activeProjectId),
    });
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBe(navigation);
    expect(container.querySelector('[data-testid="sidebar-drawer-toggle"]')).toBe(toggle);
    expect(toggle?.getAttribute("aria-label")).toBe(collapsed ? "Expand sidebar" : "Collapse sidebar");
    expect(headerPortal.querySelector('[data-testid="sidebar-team-menu-trigger"]')?.getAttribute("aria-label")).toBe("Team menu: Alpha");
    expect(headerPortal.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("aria-label")).toBe("Choose space: Core");
    expect(document.querySelectorAll('[data-testid="sidebar-team-menu-trigger"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="sidebar-space-button"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="sidebar-profile-menu"]')).toHaveLength(1);
    await click("sidebar-nav-chat");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("chat");
    expect(fixture.switchProject).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps external context controls labeled without duplicates when the sidebar is collapsed=%s", async (collapsed) => {
    await render({ navigationHeaderPortalTarget: headerPortal, collapsed });
    const team = headerPortal.querySelector('[data-testid="sidebar-team-menu-trigger"]')!;
    const space = headerPortal.querySelector('[data-testid="sidebar-space-button"]')!;
    expect(team.querySelector("[data-testid=org-identity]")).not.toBeNull();
    expect(team.getAttribute("aria-label")).toBe("Team menu: Alpha");
    expect(space.textContent).toContain("Core");
    expect(space.getAttribute("aria-label")).toBe("Choose space: Core");
    expect(container.querySelector('[data-testid="sidebar-team-menu-trigger"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="sidebar-navigation-path"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="sidebar-drawer-toggle"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-list"]')).toBeNull();
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).not.toBeNull();
    await click("sidebar-recent-space-space-a");
    expect(onActivateProject).toHaveBeenCalledExactlyOnceWith("space-a", "org-a");
  });

  it("uses a compact team avatar in the desktop header while retaining team and space menus", async () => {
    await render({ navigationPresentation: "path", navigationHeaderExternal: true, compactContextHeader: true, navigationHeaderPortalTarget: headerPortal });
    const team = headerPortal.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    expect(team.getAttribute("aria-label")).toBe("Team menu: Alpha");
    expect(team.textContent).not.toContain("Alpha");
    expect(headerPortal.querySelector('[data-testid="sidebar-space-button"]')).not.toBeNull();
    await act(async () => team.click());
    expect(document.querySelector('[data-testid="sidebar-team-menu-settings"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="sidebar-team-menu-switch"]')).not.toBeNull();
  });

  it("keeps a persistent search input mounted across focus and collapse, and separates scope removal from navigation", async () => {
    function SearchNavigation({ collapsed }: { collapsed: boolean }) {
      const search = useStudioSearch({ scopeKey: "member:org-a:space-a", org: { id: "org-a", name: "Alpha" }, space: { id: "space-a", name: "Core" }, records: [], persistentControl: true });
      return <><StudioSidebar
        items={[]} activePanel="chat" onSelect={onSelect} collapsed={collapsed}
        navigationPresentation="path" navigationHeaderExternal navigationHeaderPortalTarget={headerPortal}
        renderNavigationHeader={context => search.renderControl(false, <StudioSearchContext scope={search.scope} context={context} onBroaden={search.changeScope} />)}
        onNavigationHeaderAction={() => search.closeSearch(false)}
        workspaceSwitcherOpen={false} onWorkspaceSwitcherOpenChange={onSwitcherChange} workspaceSwitcherPortalTarget={portal}
        onActivateProject={onActivateProject} onOpenTeam={onOpenTeam}
      /><output data-testid="search-state">{`${search.open}:${search.scope}`}</output></>;
    }
    await act(async () => root.render(<BrowserRouter><SearchNavigation collapsed={false} /></BrowserRouter>));
    const input = headerPortal.querySelector<HTMLInputElement>('[data-testid="studio-search-input"]')!;
    expect(input).not.toBeNull();
    await act(async () => input.focus());
    expect(container.querySelector('[data-testid="search-state"]')?.textContent).toBe("true:space");
    await act(async () => root.render(<BrowserRouter><SearchNavigation collapsed /></BrowserRouter>));
    expect(headerPortal.querySelector('[data-testid="studio-search-input"]')).toBe(input);
    expect(document.querySelectorAll('[data-testid="sidebar-team-menu-trigger"]')).toHaveLength(1);
    await act(async () => headerPortal.querySelector<HTMLButtonElement>('[aria-label="Search within Alpha"]')!.click());
    expect(container.querySelector('[data-testid="search-state"]')?.textContent).toBe("true:org");
    expect(onActivateProject).not.toHaveBeenCalled();
    expect(onSwitcherChange).not.toHaveBeenCalled();
    await click("sidebar-team-menu-trigger");
    await click("sidebar-team-menu-switch");
    expect(container.querySelector('[data-testid="search-state"]')?.textContent).toBe("false:space");
    expect(onSwitcherChange).toHaveBeenCalledWith(true);
  });

  it.each([false, true])("uses a shell-owned context header without rendering duplicate breadcrumb controls (collapsed=%s)", async (collapsed) => {
    await render({ navigationHeaderExternal: true, collapsed });
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    expect(header.classList.contains("h-12")).toBe(true);
    expect(header.querySelector('[data-testid="sidebar-drawer-toggle"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="sidebar-navigation-path"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-team-menu-trigger"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-space-button"]')).toBeNull();
    expect(headerPortal.children).toHaveLength(0);
    const newChat = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-chat"]')!;
    expect(newChat.getAttribute("aria-label")).toBe("New chat");
    expect(newChat.closest('[data-testid="sidebar-team-header"]')).toBe(collapsed ? null : header);
    await click("sidebar-new-chat");
    expect(fixture.onStartNewConversation).not.toHaveBeenCalled();
    await click("chat-new-chat-public");
    expect(fixture.onStartNewConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["chat", false], ["chat", true],
    ["settings", false], ["settings", true],
    ["code", false], ["automations", true],
  ] as const)("creates a chat from the external-header sidebar on %s while keeping its fixed toggle (collapsed=%s)", async (activePanel, collapsed) => {
    fixture.navigationPage = activePanel === "settings" ? "account" : "workspace";
    await render({ navigationHeaderPortalTarget: headerPortal, collapsed, activePanel,
      hideContext: usesGlobalNavigationContext(fixture.navigationPage, fixture.activeProjectId),
    });
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    const toggle = header.querySelector('[data-testid="sidebar-drawer-toggle"]')!;
    const newChat = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-chat"]')!;
    expect(toggle.parentElement?.classList.contains("w-[calc(4rem-1px)]")).toBe(true);
    expect(newChat.getAttribute("aria-label")).toBe("New chat");
    expect(newChat.classList.contains("!min-h-11")).toBe(true);
    expect(newChat.textContent).toBe(collapsed ? "" : "New chat");
    expect(newChat.closest('[data-testid="sidebar-team-header"]')).toBe(collapsed ? null : header);
    if (collapsed) {
      expect(newChat.parentElement?.previousElementSibling).toBe(header);
      expect(newChat.closest('[data-testid="sidebar-context-scroll"]')).toBeNull();
    }
    await click("sidebar-new-chat");
    expect(fixture.onStartNewConversation).not.toHaveBeenCalled();
    await click("chat-new-chat-public");
    expect(fixture.onStartNewConversation).toHaveBeenCalledTimes(1);
    expect(fixture.onToggleSidebar).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "hidden", "hidden-context", "empty-team", "other-team", "missing-space", "home", "no-space"])("withholds external-header New chat when %s", async (scenario) => {
    // Mobile still mounts its sidebar on global pages, so exercise the gate
    // rather than relying on desktop Home hiding the entire context column.
    fixture.desktop = false;
    fixture.newChatAvailable = scenario !== "unavailable";
    fixture.showChatActions = scenario !== "hidden";
    fixture.navigationPage = scenario === "home" ? "home" : "account";
    if (scenario === "missing-space") fixture.activeProjectId = "missing-space";
    if (scenario === "no-space") fixture.activeProjectId = null;
    await render({ navigationHeaderPortalTarget: headerPortal, mobileOverlay: true,
      selectedOrgKey: scenario === "empty-team" ? "org-b" : scenario === "other-team" ? "org-c" : "org-a",
      activePanel: scenario === "home" ? "home" : "settings",
      hideContext: scenario === "hidden-context" || usesGlobalNavigationContext(fixture.navigationPage, fixture.activeProjectId),
    });
    expect(container.querySelector('[data-testid="sidebar-team-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-new-chat"]')).toBeNull();
    expect(fixture.onStartNewConversation).not.toHaveBeenCalled();
  });

  it.each([
    { collapsed: false, mobile: false },
    { collapsed: true, mobile: false },
    { collapsed: false, mobile: true },
  ])("retains private chat creation from Settings through the shared picker (collapsed=$collapsed, mobile=$mobile)", async ({ collapsed, mobile }) => {
    fixture.desktop = !mobile;
    fixture.navigationPage = "account";
    fixture.privateChatAvailable = true;
    let pendingAction: (() => void) | undefined;
    const runSidebarAction = vi.fn((action: () => void) => { pendingAction = action; });
    await render({ navigationHeaderExternal: true, collapsed, runSidebarAction, activePanel: "settings", mobileOverlay: mobile,
      hideContext: usesGlobalNavigationContext(fixture.navigationPage, fixture.activeProjectId),
    });
    await click("sidebar-new-chat");
    expect(document.querySelector('[data-testid="chat-new-chat-private"]')).not.toBeNull();
    await click("chat-new-chat-private");
    expect(document.querySelector('[data-testid="chat-private-chat-modal"]')).not.toBeNull();
    await click("chat-private-chat-target-teammate-id");
    expect(runSidebarAction).toHaveBeenCalledOnce();
    expect(fixture.onStartPrivateConversation).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    await act(async () => {
      if (mobile) onRequestClose();
      pendingAction!();
    });
    if (mobile) expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(fixture.onStartPrivateConversation.mock.invocationCallOrder[0]);
    expect(fixture.onStartPrivateConversation).toHaveBeenCalledExactlyOnceWith({ userId: "teammate-id", displayName: "Teammate" });
    expect(fixture.onStartNewConversation).not.toHaveBeenCalled();
  });

  it("opens an external mobile space directory scoped to its team and permits an explicit team switch", async () => {
    fixture.desktop = false;
    const navigation = { view: "workspace", openView: vi.fn(), back: vi.fn() };
    const props = {
      navigationHeaderPortalTarget: headerPortal, mobileOverlay: true,
      selectedOrgKey: "org-a", workspaceSwitcherInitialMode: "spaces" as const,
      mobileNavigation: navigation as never,
    };
    await render(props);
    const directory = document.querySelector('[data-testid="sidebar-project-switcher-menu"]')!;
    expect(directory).not.toBeNull();
    expect(directory.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(directory.textContent).toContain("Core");
    expect(directory.textContent).not.toContain("Design");

    navigation.view = "sidebar";
    await render(props);
    await chooseTeamAction("switch");
    expect(navigation.openView).toHaveBeenCalledExactlyOnceWith("workspace");
    navigation.view = "workspace";
    await render(props);
    expect(document.querySelector('[data-testid="sidebar-org-selector"]')).not.toBeNull();
  });

  it.each(["tiles", "path"] as const)("does not add the external-header New chat action to the %s presentation", async (navigationPresentation) => {
    await render({ navigationPresentation });
    expect(container.querySelector('[data-testid="sidebar-new-chat"]')).toBeNull();
  });

  it.each(["chat", "settings", "code", "automations"] as const)("closes mobile navigation on %s before creating a chat and keeps the action inert beneath a drill-in", async activePanel => {
    fixture.desktop = false;
    fixture.navigationPage = activePanel === "settings" ? "account" : "workspace";
    const navigation = { view: "sidebar", openView: vi.fn(), back: vi.fn() };
    let afterClose: (() => void) | undefined;
    const runSidebarAction = vi.fn((action: () => void) => { afterClose = action; });
    const props = { navigationHeaderPortalTarget: headerPortal, mobileOverlay: true, activePanel,
      mobileNavigation: navigation as never, runSidebarAction,
      hideContext: usesGlobalNavigationContext(fixture.navigationPage, fixture.activeProjectId),
    };
    await render(props);
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    const newChat = header.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-chat"]')!;
    expect(newChat.textContent).toBe("New chat");
    expect(header.classList.contains("flex-row-reverse")).toBe(true);
    expect(newChat.nextElementSibling?.getAttribute("data-testid")).toBe("sidebar-drawer-toggle");
    await click("sidebar-new-chat");
    expect(runSidebarAction).not.toHaveBeenCalled();
    await click("chat-new-chat-public");
    expect(runSidebarAction).toHaveBeenCalledTimes(1);
    expect(fixture.onStartNewConversation).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    await act(async () => { onRequestClose(); afterClose!(); });
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(fixture.onStartNewConversation.mock.invocationCallOrder[0]);
    expect(fixture.onStartNewConversation).toHaveBeenCalledTimes(1);

    navigation.view = "workspace";
    await render(props);
    expect(header.hasAttribute("inert")).toBe(true);
    expect(newChat.disabled).toBe(true);
    await click("sidebar-new-chat");
    expect(runSidebarAction).toHaveBeenCalledTimes(1);
    expect(fixture.onStartNewConversation).toHaveBeenCalledTimes(1);
  });

  it.each(["home", "settings"] as const)("keeps external team and space destinations available on %s", async (activePanel) => {
    await render({ navigationHeaderPortalTarget: headerPortal, activePanel, hideContext: activePanel === "settings" });
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    expect(headerPortal.querySelector('[data-testid="sidebar-team-menu-trigger"]')?.getAttribute("aria-label")).toBe("Team menu: Alpha");
    expect(headerPortal.querySelector('[data-testid="sidebar-space-button"]')?.textContent).toContain("Core");
    await chooseTeamAction("overview");
    expect(onOpenTeam).toHaveBeenCalledExactlyOnceWith("org-a");
    await click("sidebar-space-button");
    await click("sidebar-recent-space-space-a");
    expect(onActivateProject).toHaveBeenCalledExactlyOnceWith("space-a", "org-a");
  });

  it("keeps an external team trigger mounted across collapse and restores it after browsing teams on Home", async () => {
    const props = { navigationHeaderPortalTarget: headerPortal, activePanel: "home" as const };
    await render(props);
    const trigger = headerPortal.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    await click("sidebar-team-menu-trigger");
    await render({ ...props, collapsed: true });
    expect(headerPortal.querySelector('[data-testid="sidebar-team-menu-trigger"]')).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await click("sidebar-team-menu-switch");
    expect(onSwitcherChange).toHaveBeenCalledExactlyOnceWith(true);
    await render({ ...props, collapsed: true, workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-project-switcher-menu"]')).not.toBeNull();
    await click("sidebar-project-switcher-close");
    expect(onSwitcherChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves one mobile close action and restores the external avatar trigger after a team drill-in", async () => {
    fixture.desktop = false;
    const navigation = { view: "root", openView: vi.fn(), back: vi.fn() };
    const props = { navigationHeaderPortalTarget: headerPortal, mobileOverlay: true,
      mobileNavigation: navigation as never, activePanel: "home" as const,
    };
    await render(props);
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    expect(header.querySelector('[data-testid="sidebar-new-chat"]')).toBeNull();
    expect(header.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector('[data-testid="sidebar-home-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-team-menu-trigger"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')).toBeNull();
    const trigger = headerPortal.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    expect(trigger.textContent).toBe("A");
    expect(trigger.getAttribute("aria-label")).toBe(fixture.desktop ? "Team menu: Alpha" : "Choose team: Alpha");
    await chooseTeamAction("switch");
    expect(navigation.openView).toHaveBeenCalledExactlyOnceWith("workspace");
    navigation.view = "workspace";
    await render(props);
    expect(headerPortal.querySelector('[data-testid="sidebar-navigation-path"]')?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')?.closest("[inert]")).toBeNull();
    await click("sidebar-project-switcher-back");
    navigation.view = "root";
    await render(props);
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(headerPortal.querySelector('[data-testid="sidebar-navigation-path"]')?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await click("sidebar-drawer-toggle");
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps the path above chats and preserves the existing space destination (desktop=%s)", async (desktop) => {
    fixture.desktop = desktop;
    await render({ navigationPresentation: "path", mobileOverlay: !desktop, onSelectConversation: vi.fn() });
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    const path = header.querySelector('[data-testid="sidebar-navigation-path"]')!;
    expect(path).not.toBeNull();
    expect(path.querySelector('[data-testid="sidebar-team-menu-trigger"]')).not.toBeNull();
    expect(path.querySelector('[data-testid="sidebar-space-button"]')?.textContent).toContain("Core");
    const scroll = container.querySelector('[data-testid="sidebar-context-scroll"]')!;
    expect(scroll.querySelector('[data-testid="sidebar-space-button"]')).toBeNull();
    expect(scroll.firstElementChild?.textContent).toContain("Chats");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-list"]')).toBeNull();
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).not.toBeNull();
    await click("sidebar-recent-space-space-a");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    expect(onActivateProject).toHaveBeenCalledExactlyOnceWith("space-a", "org-a");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onActivateProject.mock.invocationCallOrder[0]);
  });

  it.each([true, false])("keeps the complete team identity and actions accessible behind the path initials (desktop=%s)", async (desktop) => {
    fixture.desktop = desktop;
    await render({ navigationPresentation: "path", mobileOverlay: !desktop });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    expect(trigger.textContent).toBe("A");
    expect(trigger.getAttribute("aria-label")).toBe(fixture.desktop ? "Team menu: Alpha" : "Choose team: Alpha");
    expect(trigger.title).toBe(desktop ? "Team menu: Alpha" : "Choose team: Alpha");
    await click("sidebar-team-menu-trigger");
    if (desktop) {
      const menu = document.querySelector('[role="menu"][aria-label="Team actions: Alpha"]')!;
      expect(menu).not.toBeNull();
      expect(menu.closest('[data-testid="sidebar-team-menu"]')?.textContent).toContain("Alpha");
      expect(menu.querySelector('[data-testid="sidebar-team-menu-switch"]')?.textContent).toBe("Switch team");
      await click("sidebar-team-menu-settings");
    } else {
      expect(document.querySelector('[data-testid="sidebar-org-selector"]')?.textContent).toContain("Alpha");
      await click("sidebar-org-settings-button");
    }
    expect(fixture.onSettings).toHaveBeenCalledExactlyOnceWith("org-a");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(fixture.onSettings.mock.invocationCallOrder[0]);
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
  });

  it("shows the selected team's avatar and falls back to the next team's initials in the path", async () => {
    fixture.orgs[0] = { ...fixture.orgs[0], avatarUrl: "https://assets.example.test/alpha.png" };
    await render({ navigationPresentation: "path" });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    const avatar = trigger.querySelector("img")!;
    expect(avatar.getAttribute("src")).toBe("https://assets.example.test/alpha.png");
    expect(avatar.getAttribute("alt")).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe(fixture.desktop ? "Team menu: Alpha" : "Choose team: Alpha");
    await render({ navigationPresentation: "path", selectedOrgKey: "org-b", activePanel: "team" });
    const emptyTeamTrigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    expect(emptyTeamTrigger.querySelector("img")).toBeNull();
    expect(emptyTeamTrigger.textContent).toBe("ET");
    expect(emptyTeamTrigger.getAttribute("aria-label")).toBe("Team menu: Empty team");
    await click("sidebar-team-menu-trigger");
    const menu = document.querySelector('[role="menu"][aria-label="Team actions: Empty team"]')!;
    expect(menu.closest('[data-testid="sidebar-team-menu"]')?.textContent).toContain("Empty team");
    await click("sidebar-team-menu-overview");
    expect(onOpenTeam).toHaveBeenCalledExactlyOnceWith("org-b");
  });

  it.each([true, false])("preserves current-space unread counts when its path trigger has no space icon (desktop=%s)", async (desktop) => {
    fixture.desktop = desktop;
    fixture.homeAttentionByProject = { "space-a": 12 };
    const props = { navigationPresentation: "path" as const, mobileOverlay: !desktop };
    await render(props);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-space-button"]')!;
    expect(trigger.textContent).toContain("Core");
    expect(trigger.querySelector('[data-testid="sidebar-current-space-attention"]')?.textContent).toBe("9+");
    expect(trigger.getAttribute("aria-label")).toBe("Choose space: Core, 12 unread updates");
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-space-space-a"]')?.getAttribute("aria-label")).toBe("Core, Current, 12 unread updates");
    await click("sidebar-recent-space-space-a");
    fixture.homeAttentionByProject = {};
    await render(props);
    expect(container.querySelector('[data-testid="sidebar-current-space-attention"]')).toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("Choose space: Core");
  });

  it("keeps the desktop path menu and selected team while touch posture changes", async () => {
    const props = { navigationPresentation: "path" as const };
    await render(props);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    await click("sidebar-team-menu-trigger");
    const menu = document.querySelector('[role="menu"][aria-label="Team actions: Alpha"]')!;
    expect(menu).not.toBeNull();
    fixture.touchLikeInput = true;
    await render(props);
    expect(container.querySelector('[data-testid="sidebar-team-menu-trigger"]')).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"][aria-label="Team actions: Alpha"]')).toBe(menu);
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).not.toBeNull();
    await click("sidebar-team-menu-switch");
    expect(onSwitcherChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(onActivateProject).not.toHaveBeenCalled();
  });

  it("restores the actual desktop path team trigger after explicitly browsing teams", async () => {
    const props = { navigationPresentation: "path" as const };
    await render(props);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    await chooseTeamAction("switch");
    expect(onSwitcherChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(onOpenTeam).not.toHaveBeenCalled();
    await render({ ...props, workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-project-switcher-menu"]')).not.toBeNull();
    await click("sidebar-project-switcher-close");
    expect(onSwitcherChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns from Browse teams to the compact path trigger after collapsing the sidebar", async () => {
    const props = { navigationPresentation: "path" as const };
    await render(props);
    await chooseTeamAction("switch");
    await render({ ...props, workspaceSwitcherOpen: true });
    await render({ ...props, collapsed: true, workspaceSwitcherOpen: true });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    expect(trigger.closest('[data-testid="sidebar-context-scroll"]')).not.toBeNull();
    const panel = portal.querySelector<HTMLElement>('[data-testid="sidebar-project-switcher-menu"]')!;
    expect(panel).not.toBeNull();
    await act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onSwitcherChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.isConnected).toBe(true);
  });

  it("keeps compact path navigation equivalent to the existing compact rail", async () => {
    await render({ navigationPresentation: "path", collapsed: true });
    expect(container.querySelector('[data-testid="sidebar-navigation-path"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.textContent).not.toContain("Core");
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).not.toBeNull();
    await click("sidebar-recent-space-space-a");
    await click("sidebar-team-menu-trigger");
    expect(document.querySelector('[data-testid="sidebar-team-menu-switch"]')).toBeNull();
  });

  it("retains the compact inner navigation and the same focused toggle across both widths", async () => {
    await render();
    const nav = container.querySelector('[data-testid="sidebar-context-navigation"]');
    const header = container.querySelector('[data-testid="sidebar-team-header"]');
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-toggle"]')!;
    expect(nav?.classList.contains("w-56")).toBe(true);
    // Header stays outside the scrolling tools in both states.
    expect(header?.parentElement).toBe(nav);
    expect(header?.closest('[data-testid="sidebar-context-scroll"]')).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    await act(async () => toggle.focus());
    await click("sidebar-drawer-toggle");
    expect(fixture.onToggleSidebar).toHaveBeenCalledOnce();
    await render({ collapsed: true });
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBe(nav);
    expect(nav?.classList.contains("w-[4rem]")).toBe(true);
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="sidebar-drawer-toggle"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="sidebar-drawer-toggle"]')).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(toggle.getAttribute("title")).toBe("Expand sidebar");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="sidebar-team-menu-trigger"]')?.textContent).toBe("");
    await render();
    expect(container.querySelector('[data-testid="sidebar-drawer-toggle"]')).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps icon tools, chats and More usable with accessible names and tooltips", async () => {
    const onBrowseAll = vi.fn();
    const props: Partial<ComponentProps<typeof StudioSidebar>> = {
      collapsed: true,
      onSelectConversation: vi.fn(),
      onOpenConversationHistory: onBrowseAll,
      items: [
        { id: "chat", label: "Chats", icon: () => <span />, accent: "" },
        { id: "automations", label: "Automations", icon: () => <span />, accent: "" },
        { id: "code", label: "Files", icon: () => <span />, accent: "" },
        { id: "sourceControl", label: "Changes", icon: () => <span />, accent: "" },
      ],
      moreItems: [{ id: "secrets", label: "Secrets", icon: () => <span />, accent: "" }],
    };
    await render(props);
    for (const [id, label] of [["automations", "Automations"], ["code", "Files"], ["sourceControl", "Changes"]]) {
      const tool = container.querySelector(`[data-testid="sidebar-nav-${id}"]`);
      expect(tool?.getAttribute("aria-label")).toBe(label);
      expect(tool?.getAttribute("title")).toBe(label);
      expect(tool?.textContent).toBe("");
      await click(`sidebar-nav-${id}`);
      expect(onSelect).toHaveBeenLastCalledWith(id);
    }
    await click("sidebar-nav-history");
    expect(document.querySelector('[data-testid="sidebar-recent-chats-popover"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-browse-all-chats"]')?.click());
    expect(onBrowseAll).toHaveBeenCalledOnce();
    const more = container.querySelector('[data-testid="sidebar-nav-more"]');
    expect(more?.getAttribute("aria-label")).toBe("More");
    expect(more?.getAttribute("title")).toBe("More");
    await click("sidebar-nav-more");
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).not.toBeNull();
    await render({ ...props, collapsed: false });
    await render(props);
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBeNull();
    await click("sidebar-nav-more");
    await act(async () => document.querySelector<HTMLElement>('[data-testid="sidebar-more-item-secrets"]')?.click());
    expect(onSelect).toHaveBeenLastCalledWith("secrets");
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).not.toBeNull();
    await click("sidebar-browse-all-spaces");
    await render({ ...props, workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(portal.textContent).toContain("Spaces");
  });

  it("keeps empty-team browse and create actions compact and scoped", async () => {
    const props = { collapsed: true, activePanel: "team" as const, selectedOrgKey: "org-b" };
    await render(props);
    const fallback = container.querySelector('[data-testid="sidebar-no-selected-space"]');
    expect(fallback?.textContent).toBe("");
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("title")).toBe("Choose space");
    expect(container.querySelector('[data-testid="sidebar-new-space"]')?.getAttribute("title")).toBe("New space");
    await chooseTeamAction("overview");
    expect(onOpenTeam).toHaveBeenCalledWith("org-b");
    await chooseTeamAction("settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("org-b");
    await click("sidebar-new-space");
    expect(fixture.onNewSpace).toHaveBeenCalledWith("org-b");
    await click("sidebar-space-button");
    await click("sidebar-browse-all-spaces");
    await render({ ...props, workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(portal.textContent).not.toContain("Core");
    await render({ ...props, activePanel: "settings" });
    expect(container.querySelector('[data-testid="sidebar-team-menu-trigger"] > span')?.className).toContain("border-primary-200");
  });

  it("uses the inner rail's height for overflow without reserving the outer account footer", async () => {
    let navHeight = 500;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.testid === "sidebar-context-navigation" ? navHeight : 400;
      return { x: 0, y: 0, top: 0, left: 0, width: 64, height, right: 64, bottom: height, toJSON: () => ({}) };
    });
    await render({ collapsed: true, moreItems: [
      { id: "skills", label: "Skills", icon: () => <span />, accent: "" },
      { id: "machines", label: "Machines", icon: () => <span />, accent: "" },
      { id: "secrets", label: "Secrets", icon: () => <span />, accent: "" },
    ] });
    expect(container.querySelector('[data-testid="sidebar-more-item-skills"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-more-item-machines"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-more-item-secrets"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    navHeight = 180;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(container.querySelector('[data-testid="sidebar-more-item-skills"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-more-item-machines"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-context-scroll"]')?.classList.contains("overflow-y-auto")).toBe(true);
    expect(container.querySelector('[data-testid="sidebar-team-header"]')?.closest('[data-testid="sidebar-context-scroll"]')).toBeNull();
  });

  it("does not reveal old-team tools or create permissions in an unavailable compact team", async () => {
    await render({ collapsed: true, activePanel: "team", selectedOrgKey: "unavailable-team" });
    expect(container.querySelector('[data-testid="sidebar-no-selected-space"]')?.textContent).toBe("");
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-new-space"]')).toBeNull();
    await chooseTeamAction("settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("unavailable-team");
  });

  it("keeps mobile global actions in one fixed header with space navigation immediately below", async () => {
    fixture.desktop = false;
    fixture.homeAttentionCount = 3;
    await render({ mobileOverlay: true });
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    const home = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-home-button"]')!;
    const team = container.querySelector('[data-testid="sidebar-team-menu-trigger"]');
    const close = container.querySelector('[data-testid="sidebar-drawer-toggle"]');
    const scroll = container.querySelector('[data-testid="sidebar-context-scroll"]')!;
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).toBeNull();
    expect(header.parentElement).toBe(container.querySelector('[data-testid="sidebar-context-navigation"]'));
    expect(header.children).toHaveLength(3);
    expect(header.firstElementChild).toBe(home);
    expect(home.nextElementSibling).toBe(team);
    expect(team?.nextElementSibling).toBe(close);
    expect(home.getAttribute("aria-label")).toBe("Home — all teams");
    expect(home.title).toBe("Home — all teams");
    expect(home.querySelector(".octo-mark")).not.toBeNull();
    expect(home.querySelector('[data-testid="sidebar-home-badge"]')?.textContent).toBe("3");
    expect(close?.getAttribute("aria-label")).toBe("Close navigation");
    expect(container.querySelector('[data-testid="sidebar-nav-team"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-settings"]')).toBeNull();
    expect(scroll.firstElementChild?.querySelector('[data-testid="sidebar-space-button"]')).not.toBeNull();
    expect(scroll.textContent).not.toContain("Team overview");
    await chooseTeamAction("overview");
    expect(onOpenTeam).toHaveBeenCalledWith("org-a");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onOpenTeam.mock.invocationCallOrder[0]);
    await chooseTeamAction("settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("org-a");
    onRequestClose.mockClear();
    await click("sidebar-drawer-toggle");
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(fixture.onToggleSidebar).not.toHaveBeenCalled();
  });

  it.each(["home", "chat", "settings"] as const)("keeps Home a close-before-navigation destination on narrow %s", async (activePanel) => {
    fixture.desktop = false;
    await render({ mobileOverlay: true, activePanel, hideContext: activePanel === "settings" });
    const home = container.querySelector('[data-testid="sidebar-home-button"]')!;
    expect(home.getAttribute("aria-current")).toBe(activePanel === "home" ? "page" : null);
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')).not.toBeNull();
    await click("sidebar-home-button");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("home");
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onSelect.mock.invocationCallOrder[0]);
    expect(onSwitcherChange).not.toHaveBeenCalled();
    expect(onActivateProject).not.toHaveBeenCalled();
  });

  it("opens explicit team switching inside the shared drawer and restores its menu trigger on Back", async () => {
    fixture.desktop = false;
    const navigation = { view: "root", openView: vi.fn(), back: vi.fn() };
    const props = { mobileOverlay: true, activePanel: "home" as const, mobileNavigation: navigation as never };
    await render(props);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    const search = window.location.search;
    await click("sidebar-team-menu-trigger");
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    expect(navigation.openView).toHaveBeenCalledExactlyOnceWith("workspace");
    expect(onRequestClose).not.toHaveBeenCalled();
    navigation.view = "workspace";
    await render(props);
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')?.textContent).toContain("Browse teams");
    expect(document.querySelector('[data-testid="sidebar-org-selector"]')).not.toBeNull();
    await click("sidebar-project-switcher-back");
    expect(navigation.back).toHaveBeenCalledOnce();
    navigation.view = "root";
    await render(props);
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(window.location.search).toBe(search);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(onActivateProject).not.toHaveBeenCalled();
  });

  it.each(["workspace", "more"])("hides covered root controls from interaction while the mobile %s view is open", async (view) => {
    fixture.desktop = false;
    const navigation = { view, openView: vi.fn(), back: vi.fn() };
    const props = { mobileOverlay: true, mobileNavigation: navigation as never,
      moreItems: [{ id: "secrets" as const, label: "Secrets", icon: () => <span />, accent: "" }],
    };
    await render(props);
    const rootParts = ["sidebar-team-header", "sidebar-context-scroll", "sidebar-account-navigation"];
    for (const testId of rootParts) {
      const element = container.querySelector(`[data-testid="${testId}"]`)!;
      expect(element.hasAttribute("inert")).toBe(true);
      expect(element.getAttribute("aria-hidden")).toBe("true");
    }
    const drillIn = document.querySelector(`[data-testid="${view === "workspace" ? "sidebar-project-switcher-menu" : "sidebar-more-menu"}"]`)!;
    expect(drillIn).not.toBeNull();
    expect(drillIn.closest('[inert], [aria-hidden="true"]')).toBeNull();
    navigation.view = "root";
    await render(props);
    for (const testId of rootParts) {
      const element = container.querySelector(`[data-testid="${testId}"]`)!;
      expect(element.hasAttribute("inert")).toBe(false);
      expect(element.getAttribute("aria-hidden")).toBeNull();
    }
  });

  it("returns from More to its persistent trigger before resuming mobile navigation", async () => {
    fixture.desktop = false;
    const navigation = { view: "root", openView: vi.fn(), back: vi.fn() };
    const props = { mobileOverlay: true, mobileNavigation: navigation as never, onSelectConversation: vi.fn(),
      moreItems: [{ id: "secrets" as const, label: "Secrets", icon: () => <span />, accent: "" }],
    };
    await render(props);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-nav-more"]')!;
    await click("sidebar-nav-more");
    expect(navigation.openView).toHaveBeenCalledExactlyOnceWith("more");
    navigation.view = "more";
    await render(props);
    await click("sidebar-more-back");
    expect(navigation.back).toHaveBeenCalledOnce();
    navigation.view = "root";
    await render(props);
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBeNull();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([787, 1067])("shows every permitted tool in an expanded mobile drawer with %ipx available height", async height => {
    fixture.desktop = false;
    mockSidebarHeight(height);
    await render(secondaryNavigationProps());
    expect(visibleSecondaryIds()).toEqual(["extensions", "secrets", "skills", "ai", "machines", "credits"]);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    await click("sidebar-more-item-secrets");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("secrets");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onSelect.mock.invocationCallOrder[0]);
  });

  it("keeps only overflowing mobile tools in More and reallocates them after a height change", async () => {
    fixture.desktop = false;
    const resize = mockSidebarHeight(580);
    await render(secondaryNavigationProps());
    expect(visibleSecondaryIds()).toEqual(["extensions"]);
    expect(container.querySelector('[data-testid="sidebar-context-scroll"]')?.classList.contains("overflow-y-auto")).toBe(true);
    await click("sidebar-nav-more");
    const more = document.querySelector('[data-testid="sidebar-more-menu"]')!;
    expect(visibleSecondaryIds(more)).toEqual(["secrets", "skills", "ai", "machines", "credits"]);
    await click("sidebar-more-back");
    await resize(1067);
    expect(visibleSecondaryIds()).toEqual(["extensions", "secrets", "skills", "ai", "machines", "credits"]);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    await resize(580);
    expect(visibleSecondaryIds()).toEqual(["extensions"]);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).not.toBeNull();
  });

  it("keeps an open mobile More view stable during resize and returns focus to its newly inline tools", async () => {
    fixture.desktop = false;
    const resize = mockSidebarHeight(580);
    const navigation = { view: "sidebar", openView: vi.fn(), back: vi.fn() };
    const props = { ...secondaryNavigationProps(), mobileNavigation: navigation as never };
    await render(props);
    await click("sidebar-nav-more");
    expect(navigation.openView).toHaveBeenCalledExactlyOnceWith("more");
    navigation.view = "more";
    await render(props);
    await resize(1067);
    const more = document.querySelector('[data-testid="sidebar-more-menu"]')!;
    expect(visibleSecondaryIds(more)).toEqual(["secrets", "skills", "ai", "machines", "credits"]);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).not.toBeNull();
    await click("sidebar-more-back");
    expect(navigation.back).toHaveBeenCalledOnce();
    navigation.view = "sidebar";
    await render(props);
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="sidebar-more-item-secrets"]'));
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    [false, 712], [true, 712],
    [false, 1067], [true, 1067],
  ] as const)("shows every permitted tool inline beneath an external desktop header without More (collapsed=%s, height=%i)", async (collapsed, height) => {
    mockSidebarHeight(height);
    await render({ ...secondaryNavigationProps(), mobileOverlay: false, collapsed, activePanel: "secrets" });
    expect(visibleSecondaryIds()).toEqual(["extensions", "secrets", "skills", "ai", "machines", "credits"]);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    const secrets = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-more-item-secrets"]')!;
    expect(secrets.getAttribute("aria-current")).toBe("page");
    expect(collapsed ? secrets.getAttribute("aria-label") : secrets.textContent).toBe("Secrets");
    await click("sidebar-more-item-secrets");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("secrets");
  });

  it.each([false, true])("keeps desktop More stable during resize and restores focus to its newly inline tools after dismissal (collapsed=%s)", async collapsed => {
    const resize = mockSidebarHeight(360);
    await render({ ...secondaryNavigationProps(), mobileOverlay: false, collapsed });
    const inlineIds = collapsed ? ["extensions"] : [];
    const overflowIds = collapsed
      ? ["secrets", "skills", "ai", "machines", "credits"]
      : ["extensions", "secrets", "skills", "ai", "machines", "credits"];
    expect(visibleSecondaryIds()).toEqual(inlineIds);
    await click("sidebar-nav-more");
    const more = document.querySelector('[data-testid="sidebar-more-menu"]')!;
    expect(more).not.toBeNull();
    expect(visibleSecondaryIds(more)).toEqual(overflowIds);
    await click("sidebar-more-item-credits");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("credits");
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBeNull();
    await click("sidebar-nav-more");
    const openMore = document.querySelector('[data-testid="sidebar-more-menu"]')!;
    const firstOverflowItem = openMore.querySelector<HTMLElement>(`[data-testid="sidebar-more-item-${overflowIds[0]}"]`)!;
    await act(async () => firstOverflowItem.focus());
    expect(document.activeElement).toBe(firstOverflowItem);
    await resize(1067);
    expect(visibleSecondaryIds()).toEqual(inlineIds);
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBe(openMore);
    expect(visibleSecondaryIds(openMore)).toEqual(overflowIds);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).not.toBeNull();
    expect(document.activeElement).toBe(firstOverflowItem);
    await act(async () => firstOverflowItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(visibleSecondaryIds()).toEqual(["extensions", "secrets", "skills", "ai", "machines", "credits"]);
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(`[data-testid="sidebar-more-item-${overflowIds[0]}"]`));
    await resize(360);
    expect(visibleSecondaryIds()).toEqual(inlineIds);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="sidebar-more-menu"]')).toBeNull();
  });

  it.each([false, true])("does not reveal the old space's secondary tools in another team despite ample desktop height (collapsed=%s)", async collapsed => {
    mockSidebarHeight(1067);
    await render({ ...secondaryNavigationProps(), mobileOverlay: false, collapsed, selectedOrgKey: "org-b", activePanel: "team" });
    expect(visibleSecondaryIds()).toEqual([]);
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["org-b", "personal"])("keeps narrow %s scope isolated from the previous space", async (selectedOrgKey) => {
    fixture.desktop = false;
    await render({ mobileOverlay: true, activePanel: "team", selectedOrgKey });
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')).toBeNull();
    await click("sidebar-team-menu-trigger");
    expect(document.querySelector('[data-testid="sidebar-org-selector"]')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-testid="sidebar-org-settings-button"]')?.disabled).toBe(selectedOrgKey === "personal");
    await click("sidebar-org-overview-button");
    expect(onOpenTeam).toHaveBeenCalledExactlyOnceWith(selectedOrgKey);
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onOpenTeam.mock.invocationCallOrder[0]);
  });

  it("returns to the same team's remembered work from Home without switching projects", async () => {
    await render({ activePanel: "home", selectedOrgKey: "org-a" });
    await click("sidebar-team-org-a");
    expect(onReturnToTeam).toHaveBeenCalledWith("org-a");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onReturnToTeam.mock.invocationCallOrder[0]);
    expect(fixture.switchProject).not.toHaveBeenCalled();
  });

  it("opens an empty team explicitly after discovery instead of reusing the old space", async () => {
    await render();
    await click("sidebar-team-org-b");
    expect(onOpenTeam).toHaveBeenCalledWith("org-b");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onOpenTeam.mock.invocationCallOrder[0]);
    expect(fixture.switchProject).not.toHaveBeenCalled();
    await render({ activePanel: "team", selectedOrgKey: "org-b" });
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-no-selected-space"]')).not.toBeNull();
    await chooseTeamAction("settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("org-b");
  });

  it("reactivates the already loaded project's team from a different empty overview", async () => {
    await render({ activePanel: "team", selectedOrgKey: "org-b" });
    await click("sidebar-team-org-a");
    expect(onActivateProject).toHaveBeenCalledWith("space-a", "org-a");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onActivateProject.mock.invocationCallOrder[0]);
    expect(fixture.switchProject).not.toHaveBeenCalled();
  });

  it("activates a populated team's selected project through its destination callback", async () => {
    await render({ activePanel: "home" });
    await click("sidebar-team-org-c");
    expect(fixture.switchProject).not.toHaveBeenCalled();
    expect(fixture.createProject).not.toHaveBeenCalled();
    expect(onActivateProject).toHaveBeenCalledWith("space-c", "org-c");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onActivateProject.mock.invocationCallOrder[0]);
  });

  it("opens scoped team actions from the inner heading and limits the separate picker to spaces", async () => {
    await render();
    await chooseTeamAction("overview");
    expect(onOpenTeam).toHaveBeenCalledWith("org-a");
    await chooseTeamAction("settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("org-a");
    await click("sidebar-browse-all-spaces");
    await render({ workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(portal.textContent).toContain("Spaces");
    await render({ workspaceSwitcherOpen: false });
    await click("sidebar-browse-teams");
    await render({ workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).not.toBeNull();
  });

  it("keeps the current space above an inline grid and toggles it without navigating", async () => {
    await render();
    const trigger = container.querySelector('[data-testid="sidebar-space-button"]');
    expect(trigger?.textContent).toContain("Core");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    const search = window.location.search;
    const historyState = window.history.state;
    await click("sidebar-space-button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')).toBeNull();
    await click("sidebar-space-button");
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')).not.toBeNull();
    expect(onSwitcherChange).not.toHaveBeenCalled();
    expect(onActivateProject).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(window.location.search).toBe(search);
    expect(window.history.state).toBe(historyState);
    await click("sidebar-browse-all-spaces");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    expect(onSwitcherChange).toHaveBeenCalledWith(true);
  });

  it("scopes recent spaces to the selected team and activates through the existing destination owner", async () => {
    recordProjectOpened("space-c", 100, fixture.userEmail);
    await render();
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-c"]')).toBeNull();
    await render({ activePanel: "team", selectedOrgKey: "org-c" });
    expect(document.querySelector('[data-testid="sidebar-recent-space-space-a"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-recent-space-space-c"]')).not.toBeNull();
    await click("sidebar-recent-space-space-c");
    expect(onActivateProject).toHaveBeenCalledWith("space-c", "org-c");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onActivateProject.mock.invocationCallOrder[0]);
    expect(onSwitcherChange).not.toHaveBeenCalled();
  });

  it("keeps recent space tiles in alphabetical order after switching and exposes scoped unread chat counts", async () => {
    fixture.projects.push(
      { id: "space-z", name: "Zebra", orgId: "org-a", orgName: "Alpha", state: null, isRemoteOnly: false },
      { id: "space-apps", name: "Apps", orgId: "org-a", orgName: "Alpha", state: null, isRemoteOnly: false },
    );
    fixture.homeAttentionByProject = { "space-a": 2, "space-z": 12, "space-apps": 0, "space-c": 7 };
    recordProjectOpened("space-a", 200, fixture.userEmail);
    recordProjectOpened("space-z", 300, fixture.userEmail);
    recordProjectOpened("space-apps", 100, fixture.userEmail);
    recordProjectOpened("space-c", 400, fixture.userEmail);
    const visibleTileIds = () => Array.from(container.querySelectorAll('[data-testid="sidebar-recent-spaces-list"] button[data-testid^="sidebar-recent-space-"]'))
      .map((button) => button.getAttribute("data-testid"));
    const expectedOrder = ["sidebar-recent-space-space-apps", "sidebar-recent-space-space-a", "sidebar-recent-space-space-z"];

    await render();
    expect(visibleTileIds()).toEqual(expectedOrder);
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')?.getAttribute("aria-label")).toBe("Core, Current, 2 unread updates");
    expect(container.querySelector('[data-testid="sidebar-recent-space-attention-space-a"]')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="sidebar-current-space-attention"]')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-z"]')?.getAttribute("aria-label")).toBe("Zebra, 12 unread updates");
    expect(container.querySelector('[data-testid="sidebar-recent-space-attention-space-z"]')?.textContent).toBe("9+");
    expect(container.querySelector('[data-testid="sidebar-recent-space-attention-space-apps"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-c"]')).toBeNull();

    await click("sidebar-recent-space-space-z");
    expect(onActivateProject).toHaveBeenCalledExactlyOnceWith("space-z", "org-a");
    fixture.activeProjectId = "space-z";
    await act(async () => recordProjectOpened("space-z", 500, fixture.userEmail));
    await render();
    expect(visibleTileIds()).toEqual(expectedOrder);
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-z"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')?.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.textContent).toContain("Zebra");
    expect(container.querySelector('[data-testid="sidebar-current-space-attention"]')?.textContent).toBe("9+");
    expect(onSwitcherChange).not.toHaveBeenCalled();
  });

  it("offers Browse all spaces directly for an empty selected team without old-space tools or counts", async () => {
    fixture.homeAttentionByProject = { "space-a": 5 };
    await render({ activePanel: "team", selectedOrgKey: "org-b" });
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')?.textContent).toContain("No recent spaces in this team");
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-current-space-attention"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-no-selected-space"]')).not.toBeNull();
    await click("sidebar-browse-all-spaces");
    expect(onSwitcherChange).toHaveBeenCalledWith(true);
    expect(onActivateProject).not.toHaveBeenCalled();
    await render({ activePanel: "team", selectedOrgKey: "org-b", workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(portal.textContent).not.toContain("Core");
  });

  it("refreshes recent Spaces while mounted and drops history from the previous account", async () => {
    await render({ activePanel: "team", selectedOrgKey: "org-c" });
    expect(document.querySelector('[data-testid="sidebar-recent-space-space-c"]')).toBeNull();
    await act(async () => recordProjectOpened("space-c", 100, fixture.userEmail));
    expect(document.querySelector('[data-testid="sidebar-recent-space-space-c"]')).not.toBeNull();
    fixture.userEmail = "different@example.test";
    await render({ activePanel: "team", selectedOrgKey: "org-c" });
    expect(container.querySelector('[data-testid="sidebar-recent-space-space-c"]')).toBeNull();
  });

  it("resets a compact Spaces popover when the team changes", async () => {
    await render({ collapsed: true });
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).not.toBeNull();
    await render({ collapsed: true, selectedOrgKey: "org-b", activePanel: "team" });
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')?.textContent).toContain("No recent spaces in this team");
    expect(document.querySelector('[data-testid="sidebar-recent-space-space-a"]')).toBeNull();
  });

  it("uses the mobile drawer's existing browse transition and closes before a recent destination", async () => {
    fixture.desktop = false;
    const navigation = { view: "root", openView: vi.fn(), back: vi.fn() };
    await render({ mobileOverlay: true, mobileNavigation: navigation as never });
    await click("sidebar-browse-all-spaces");
    expect(navigation.openView).toHaveBeenCalledWith("workspace");
    navigation.view = "workspace";
    await render({ mobileOverlay: true, mobileNavigation: navigation as never });
    expect(document.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')?.textContent).toContain("Spaces");
    navigation.view = "root";
    await render({ mobileOverlay: true, mobileNavigation: navigation as never });
    expect(onSwitcherChange).not.toHaveBeenCalled();
    await click("sidebar-recent-space-space-a");
    expect(onActivateProject).toHaveBeenCalledWith("space-a", "org-a");
    expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(onActivateProject.mock.invocationCallOrder[0]);
  });

  it("does not expose the previous team's settings or tools in Personal scope", async () => {
    await render({ selectedOrgKey: "personal", activePanel: "team" });
    expect(container.querySelector('[data-testid="sidebar-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-profile-menu"]')).not.toBeNull();
    expect(fixture.onSettings).not.toHaveBeenCalled();
    await click("sidebar-team-menu-trigger");
    expect(document.querySelector('[data-testid="sidebar-team-menu-settings"]')).toBeNull();
    await click("sidebar-team-menu-overview");
    expect(onOpenTeam).toHaveBeenCalledWith("personal");
  });

  it.each([false, true])("consolidates desktop team actions into one anchored menu (compact=%s)", async (collapsed) => {
    await render({ collapsed });
    const header = container.querySelector('[data-testid="sidebar-team-header"]')!;
    const scroll = container.querySelector('[data-testid="sidebar-context-scroll"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    expect(header.contains(trigger)).toBe(!collapsed);
    expect(scroll.contains(trigger)).toBe(collapsed);
    expect(container.querySelector('[data-testid="sidebar-nav-team"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-settings"]')).toBeNull();
    expect(trigger.getAttribute("title")).toBe("Team menu: Alpha");
    if (!collapsed) expect(scroll.firstElementChild?.querySelector('[data-testid="sidebar-space-button"]')).not.toBeNull();
    const search = window.location.search;
    const historyState = window.history.state;
    await click("sidebar-team-menu-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Team actions: Alpha");
    expect(document.querySelector('[data-testid="sidebar-team-menu-switch"]')).toBeNull();
    expect(portal.querySelector('[data-testid="sidebar-project-switcher-menu"]')).toBeNull();
    expect(onSwitcherChange).not.toHaveBeenCalled();
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(window.location.search).toBe(search);
    expect(window.history.state).toBe(historyState);
    await click("sidebar-team-menu-overview");
    expect(onOpenTeam).toHaveBeenCalledExactlyOnceWith("org-a");
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    await chooseTeamAction("settings");
    expect(fixture.onSettings).toHaveBeenCalledExactlyOnceWith("org-a");
  });

  it("omits team settings when the callback is unavailable", async () => {
    fixture.settingsAvailable = false;
    await render();
    await click("sidebar-team-menu-trigger");
    expect(document.querySelector('[data-testid="sidebar-team-menu-settings"]')).toBeNull();
    await click("sidebar-team-menu-overview");
    expect(onOpenTeam).toHaveBeenCalledWith("org-a");
    expect(fixture.onSettings).not.toHaveBeenCalled();
  });

  it("closes team menus on selected-team, account, width, page and mobile posture changes", async () => {
    const transitions: Array<Partial<ComponentProps<typeof StudioSidebar>>> = [
      { selectedOrgKey: "org-b" }, { collapsed: true }, { activePanel: "code" },
      { activePanel: "home" }, { hideContext: true }, { mobileOverlay: true },
    ];
    for (const nextProps of transitions) {
      await render();
      await click("sidebar-team-menu-trigger");
      expect(document.querySelector('[data-testid="sidebar-team-menu"]')).not.toBeNull();
      await render(nextProps);
      expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
      await render();
      expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    }
    await click("sidebar-team-menu-trigger");
    fixture.userEmail = "another-member@example.test";
    await render();
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    await click("sidebar-team-menu-trigger");
    fixture.desktop = false;
    await render();
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    fixture.desktop = true;
    await render();
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
  });

  it("supports keyboard menu navigation and restores trigger focus on Escape", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-menu-trigger"]')!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const overview = document.querySelector('[data-testid="sidebar-team-menu-overview"]')!;
    const settings = document.querySelector('[data-testid="sidebar-team-menu-settings"]')!;
    expect(document.activeElement).toBe(overview);
    await act(async () => overview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(settings);
    await act(async () => settings.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(fixture.onSettings).not.toHaveBeenCalled();
  });

  it("publishes resolved selected-team metadata only when its identity changes", async () => {
    const onActiveTeamChange = vi.fn();
    await render({ onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", accentColor: null, avatarUrl: null });
    const initialCalls = onActiveTeamChange.mock.calls.length;
    await render({ collapsed: true, onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls);
    await render({ selectedOrgKey: "org-b", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-b", name: "Empty team", accentColor: null, avatarUrl: null });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls + 1);
  });

  it("publishes selected-team avatar changes and clears images for other scopes", async () => {
    const onActiveTeamChange = vi.fn();
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: `https://images.example.test/${org.id}.png` }));
    await render({ onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", accentColor: null, avatarUrl: "https://images.example.test/org-a.png" });
    const initialCalls = onActiveTeamChange.mock.calls.length;
    await render({ collapsed: true, onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls);
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: org.id === "org-a" ? "https://images.example.test/updated.png" : org.avatarUrl }));
    await act(async () => { window.dispatchEvent(new Event("instafy:orgs-updated")); });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", accentColor: null, avatarUrl: "https://images.example.test/updated.png" });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls + 1);
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: org.id === "org-a" ? null : org.avatarUrl }));
    await act(async () => { window.dispatchEvent(new Event("instafy:orgs-updated")); });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", accentColor: null, avatarUrl: null });
    await render({ selectedOrgKey: "org-b", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-b", name: "Empty team", accentColor: null, avatarUrl: "https://images.example.test/org-b.png" });
    await render({ selectedOrgKey: "org-unknown", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-unknown", name: "Team", accentColor: null, avatarUrl: null });
    await render({ selectedOrgKey: "personal", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith(expect.objectContaining({ key: "personal", avatarUrl: null }));
  });

  it("does not republish the previous account's avatar while the new account hydrates", async () => {
    const onActiveTeamChange = vi.fn();
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: "https://images.example.test/previous-account.png" }));
    await render({ onActiveTeamChange });
    const previousCalls = onActiveTeamChange.mock.calls.length;
    fixture.userEmail = "other@example.test";
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: null }));
    await render({ onActiveTeamChange });
    const nextAccountCalls = onActiveTeamChange.mock.calls.slice(previousCalls);
    expect(nextAccountCalls.length).toBeGreaterThan(0);
    expect(nextAccountCalls.every(([team]) => team.avatarUrl === null)).toBe(true);
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", accentColor: null, avatarUrl: null });
  });

  it("reveals a failed rail switch with Retry, preserves its scope, and respects dismissal", async () => {
    fixture.discoveryError = "Couldn't load spaces.";
    fixture.discoveryResolved = false;
    await render();
    await click("sidebar-team-org-b");
    expect(onSwitcherChange.mock.calls.filter(([open]) => open === true)).toHaveLength(1);
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(fixture.switchProject).not.toHaveBeenCalled();
    await render({ workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-chip-org-b"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(portal.querySelector('[data-testid="sidebar-project-discovery-error"]')?.textContent).toContain("Couldn't load spaces.");
    await act(async () => portal.querySelector<HTMLButtonElement>('[data-testid="sidebar-project-discovery-retry"]')?.click());
    expect(fixture.retry).toHaveBeenCalledOnce();
    await act(async () => portal.querySelector<HTMLButtonElement>('[data-testid="sidebar-project-switcher-close"]')?.click());
    await render({ workspaceSwitcherOpen: false });
    fixture.discoveryRefreshing = true;
    await render();
    fixture.discoveryRefreshing = false;
    await render();
    expect(onSwitcherChange.mock.calls.filter(([open]) => open === true)).toHaveLength(1);
    // A successful retry still resolves the original empty team after dismissal.
    fixture.discoveryError = null;
    fixture.discoveryResolved = true;
    await render();
    expect(onOpenTeam).toHaveBeenCalledWith("org-b");
    expect(fixture.switchProject).not.toHaveBeenCalled();
  });
});
