// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../../conversations/conversationState";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../../workspace/WorkspaceTabsProvider";
import { AutomationsPanel } from "../studio/components/AutomationsPanel";
import { useStudioLayoutWorkspaceRouting } from "../useStudioLayoutWorkspaceRouting";
import { resolveSettingsRoute } from "../studio/settingsRoute";
import { useSettingsOrganization } from "../studio/components/useSettingsOrganization";
import { resolveTeamNavigationScope } from "../studio/teamNavigation";
import { useStudioNavigation, StudioNavigationProvider } from "../../navigation/useStudioNavigation";
import { useMobileSidebarHistory } from "../useMobileSidebarHistory";
import type { StudioPanel } from "../studio/types";
import type { LeftDrawerPanel } from "../useStudioLayoutChromeState";

const fixture = vi.hoisted(() => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  emptyTeamId: "22222222-2222-4222-8222-222222222222",
  projectTeamId: "44444444-4444-4444-8444-444444444444",
  threadId: "automation-thread",
  controllerId: "33333333-3333-4333-8333-333333333333",
  listAutomations: vi.fn(),
}));
// Only data sources are replaced. Tabs, URL intents, router and route hydration remain real.
vi.mock("../../conversations/ConversationsProvider", () => ({ useConversations: () => useContext(DataContext)!.conversations }));
vi.mock("../../workspace/useWorkspace", () => ({ useWorkspaceUi: () => useContext(DataContext)!.workspace }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: fixture.projectId }) }));
vi.mock("../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: fixture.projectId }) }));
vi.mock("../../code/useCode", () => ({ useCode: () => ({ workspace: { files: [] }, setActiveFile: () => {} }) }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "test-user" } }) }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: () => {} }) }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { automations: { listForProject: fixture.listAutomations } } }));
vi.mock("../../services/runtimeController/projects", () => ({ listControllerOrganizations: async () => [
  { id: fixture.projectTeamId, name: "Project team", slug: "project-team", role: "builder" },
  { id: fixture.emptyTeamId, name: "Empty team", slug: "empty-team", role: "owner" },
] }));

type Data = {
  workspace: { activePanel: StudioPanel; setActivePanel: (panel: StudioPanel) => void };
  conversations: {
    conversations: ConversationState[];
    activeConversationId: string;
    projectKey: string;
    remoteConversationHistoryResolved: boolean;
    selectConversation: (id: string) => void;
    setConversationControllerId: (id: string, controllerId: string | null) => void;
    markConversationRead: () => void;
    createConversation: () => ConversationState;
  };
};
const DataContext = createContext<Data | null>(null);
function DataProvider({ children }: { children: ReactNode }) {
  const [activePanel, setActivePanel] = useState<StudioPanel>("automations");
  const [activeConversationId, selectConversation] = useState("previous-chat");
  const [conversations, setConversations] = useState(() => [
    { ...createInitialConversation({ localId: "previous-chat" }), title: "Previous chat", controllerId: null },
    { ...createInitialConversation({ localId: fixture.threadId }), title: "Autofix automation thread", controllerId: fixture.controllerId },
  ]);
  const setConversationControllerId = useCallback((id: string, controllerId: string | null) => {
    setConversations((previous) => previous.map((conversation) => conversation.localId === id ? { ...conversation, controllerId } : conversation));
  }, []);
  const value = useMemo<Data>(() => ({
    workspace: { activePanel, setActivePanel },
    conversations: { conversations, activeConversationId, projectKey: fixture.projectId,
      remoteConversationHistoryResolved: true, selectConversation, setConversationControllerId,
      markConversationRead: () => {}, createConversation: () => createInitialConversation() },
  }), [activeConversationId, activePanel, conversations, setConversationControllerId]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function RoutedTabs() {
  const location = useLocation();
  const restore = useStudioNavigation();
  return <WorkspaceTabsProvider locationSearch={location.search} onRestorePanelDestination={restore}><RoutedWorkspace /></WorkspaceTabsProvider>;
}

function RoutedWorkspace() {
  const tabs = useWorkspaceTabs();
  const data = useContext(DataContext)!;
  const location = useLocation();
  const navigate = useNavigate();
  const [leftDrawer, setLeftDrawer] = useState<LeftDrawerPanel | null>(null);
  const [isLargeScreen, setIsLargeScreen] = useState(true);
  const sidebar = useMobileSidebarHistory({ enabled: !isLargeScreen, scopeKey: `test-user:${fixture.projectId}` });
  const setMobileSidebarOpen = sidebar.setMobileSidebarOpen;
  const runAfterSidebarClose = sidebar.runAfterSidebarClose;
  const consumeUrlNavigation = tabs.consumeUrlNavigation;
  const runNavigation = useCallback((action: () => void) => runAfterSidebarClose(() => {
    consumeUrlNavigation();
    action();
  }), [consumeUrlNavigation, runAfterSidebarClose]);
  const go = useStudioNavigation(runNavigation);
  const [, setIsProjectLauncherOpen] = useState(false);
  const tab = tabs.activeTab;
  const conversation = data.conversations.conversations.find((item) => item.localId === data.conversations.activeConversationId);
  const route = useStudioLayoutWorkspaceRouting({
    activeConversationControllerId: conversation?.controllerId ?? null,
    activeConversationId: data.conversations.activeConversationId,
    activePanel: data.workspace.activePanel,
    activeProjectId: fixture.projectId,
    activeWorkspaceGitReviewReturnTabId: null,
    activeWorkspaceReviewTabId: null,
    activeWorkspaceTabConversationId: tab?.kind === "jobThread" ? tab.conversationId : null,
    activeWorkspaceTabId: tabs.activeTabId,
    activeWorkspaceTabJobId: tab?.kind === "jobThread" ? tab.jobId : null,
    activeWorkspaceTabKind: tab?.kind ?? null,
    activeWorkspaceTabPanel: tab?.kind === "panel" ? tab.panel : null,
    conversationTabsReady: tabs.conversationTabsReady,
    consumeUrlNavigation: tabs.consumeUrlNavigation,
    conversations: data.conversations.conversations,
    conversationsProjectKey: fixture.projectId,
    focusWorkspaceTab: tabs.focusTab,
    isLargeScreen,
    leftDrawer,
    locationPathname: location.pathname,
    locationSearch: location.search,
    locationKey: location.key,
    locationState: location.state,
    navigate,
    openConversationTab: tabs.openConversationTab,
    openJobThreadTab: tabs.openJobThreadTab,
    openPanelTab: tabs.openPanelTab,
    peekUrlNavigation: tabs.peekUrlNavigation,
    projectReadyForWorkspace: true,
    requestUrlNavigation: tabs.requestUrlNavigation,
    restoreGitReviewTab: tabs.restoreGitReviewTab,
    selectConversation: data.conversations.selectConversation,
    setConversationControllerId: data.conversations.setConversationControllerId,
    setIsProjectLauncherOpen,
    setLeftDrawer,
    setMobileSidebarOpen,
    workspaceTabs: tabs.tabs,
  });
  const organization = useSettingsOrganization({
    enabled: true, userId: "test-user", projectOrganizationId: fixture.projectTeamId,
    organizationId: route.settingsOrgId, selectOrganization: tab?.kind === "panel" && tab.panel === "settings",
  });
  const navigationScope = resolveTeamNavigationScope(location.search, fixture.projectTeamId);
  return <StudioNavigationProvider value={runNavigation}>
    <button data-testid="open-preferences" onClick={() => go({ kind: "panel", panel: "settings", settingsTab: "profile", settingsCategory: "preferences" })}>Preferences</button>
    <button data-testid="keep-active-tab" onClick={() => tabs.activeTabId && tabs.keepTabOpen(tabs.activeTabId)}>Keep open</button>
    <button data-testid="focus-settings-tab" onClick={() => { tabs.requestUrlPush(); tabs.focusTab("workspace-tab-settings"); }}>Settings tab</button>
    <button data-testid="close-active-tab" onClick={() => tabs.activeTabId && tabs.closeTab(tabs.activeTabId)}>Close tab</button>
    <button data-testid="use-mobile" onClick={() => setIsLargeScreen(false)}>Mobile layout</button>
    <button data-testid="open-drawer" onClick={() => sidebar.setMobileSidebarOpen(true)}>Open drawer</button>
    <button data-testid="drill-workspaces" onClick={() => sidebar.mobileSidebarNavigation.openView("workspace")}>Spaces</button>
    <output data-testid="drawer-view">{sidebar.mobileSidebarNavigation.view ?? "closed"}</output>
    <button data-testid="open-empty-team-overview" onClick={() => {
      go({ kind: "panel", panel: "team", teamId: fixture.emptyTeamId });
    }}>Open empty team</button>
    <button data-testid="open-home" onClick={() => {
      go({ kind: "panel", panel: "home", teamId: navigationScope.orgKey });
    }}>Home</button>
    <button data-testid="open-workspace-automations" onClick={() => go({ kind: "panel", panel: "automations" })}>Open workspace automations</button>
    <button data-testid="navigate-back" onClick={() => {
      tabs.consumeUrlNavigation();
      void navigate(-1);
    }}>Back</button>
    <button data-testid="activate-retained-workspace" onClick={() => {
      // Closing the real team/space drawer requests a tab URL push before
      // StudioLayout navigates to the selected space's remembered URL.
      tabs.requestUrlNavigation("push");
      setLeftDrawer(null);
      go({ kind: "conversation", projectId: fixture.projectId });
    }}>Activate retained workspace</button>
    <button data-testid="open-empty-team-profile" onClick={() => {
      // The sidebar action and settings action share the same collapse owner.
      runNavigation(() => go({ kind: "panel", panel: "settings", settingsTab: "org",
        settingsOrgId: fixture.emptyTeamId, settingsCategory: "profile" }));
    }}>Open empty team profile</button>
    <output data-testid="workspace-tab-ids">{tabs.tabs.map(tab => tab.id).join(",")}</output>
    <output data-testid="selected-workspace-tab">{tab?.kind}:{tab?.id}</output>
    <output data-testid="active-panel">{data.workspace.activePanel}</output>
    <output data-testid="navigation-scope" data-page={navigationScope.page}>{navigationScope.orgKey}</output>
    {tab?.kind === "panel" && tab.panel === "team" ? <main data-testid="visible-team-overview">{navigationScope.orgKey}</main> : null}
    {tab?.kind === "panel" && tab.panel === "home" ? <main data-testid="visible-home">{navigationScope.orgKey}</main> : null}
    {tab?.kind === "panel" && tab.panel === "automations" ? <AutomationsPanel /> : null}
    {tab?.kind === "conversation" ? <main data-testid="visible-chat" data-conversation-id={tab.conversationId}>
      {data.conversations.conversations.find((item) => item.localId === tab.conversationId)?.title}
    </main> : null}
    {tab?.kind === "panel" && tab.panel === "settings" ? <>
      <main data-testid="visible-team-settings" data-settings-tab={route.settingsTab}
        data-settings-category={resolveSettingsRoute(location.search, route.settingsTab).category} data-role={organization.role}>
        {organization.selectedId}
      </main>
      <button data-testid="select-empty-team" onClick={() => {
        organization.select(fixture.emptyTeamId);
        go({ kind: "panel", panel: "settings", settingsTab: "org", settingsOrgId: fixture.emptyTeamId,
          settingsCategory: resolveSettingsRoute(window.location.search, "org").category });
      }}>Select empty team</button>
    </> : null}
  </StudioNavigationProvider>;
}

describe("automation workspace navigation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear(); window.sessionStorage.clear();
    window.history.replaceState(null, "", `/studio?projectId=${fixture.projectId}&panel=automations`);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    fixture.listAutomations.mockReset().mockResolvedValue([{
      id: "automation-a", projectId: fixture.projectId, userId: "test-user", name: "Autofix worker", promptText: "Fix bugs",
      metadata: {}, scheduleKind: "hourly", runAt: null, intervalHours: 1, byDay: [], byHour: null, byMinute: null,
      timezone: "UTC", runtimeMode: "auto", runtimeProvider: null, conversationId: fixture.threadId,
      silentWhenNothingToReport: false, status: "active", lockedUntil: null, lastRunAt: null, nextRunAt: null,
      lastError: null, createdAt: "2026-09-08", updatedAt: "2026-09-08",
    }]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); queryClient.clear(); vi.unstubAllGlobals();
  });
  async function settle() {
    for (let pass = 0; pass < 4; pass += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  async function render() {
    await act(async () => root.render(<BrowserRouter><QueryClientProvider client={queryClient}><DataProvider><RoutedTabs /></DataProvider></QueryClientProvider></BrowserRouter>));
    await settle();
  }
  async function back() {
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      window.history.back();
      await popped;
    });
    await settle();
  }
  async function forward() {
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      window.history.forward();
      await popped;
    });
    await settle();
  }
  async function click(testId: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
    await settle();
  }
  function expectRoute(panel: StudioPanel, scope: string, expectedParams: Record<string, string>) {
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual(expectedParams);
    expect(container.querySelector('[data-testid="active-panel"]')?.textContent).toBe(panel);
    expect(container.querySelector('[data-testid="selected-workspace-tab"]')?.textContent).toBe(`panel:workspace-tab-${panel}`);
    expect(container.querySelector('[data-testid="navigation-scope"]')?.textContent).toBe(scope);
  }
  it("reuses utility previews and restores a kept section on focus or close without URL hydration bouncing back", async () => {
    await render();
    await click("open-preferences"); await click("keep-active-tab");
    await click("open-home"); await click("focus-settings-tab");
    expect(new URLSearchParams(window.location.search).get("settingsCategory")).toBe("preferences");
    expect(container.querySelector('[data-testid="selected-workspace-tab"]')?.textContent).toBe("panel:workspace-tab-settings");
    await click("open-home");
    const indexBeforeClose = window.history.state.idx;
    await click("close-active-tab");
    expect(new URLSearchParams(window.location.search).get("settingsCategory")).toBe("preferences");
    expect(new URLSearchParams(window.location.search).get("settingsTab")).toBe("profile");
    expect(container.querySelector('[data-testid="selected-workspace-tab"]')?.textContent).toBe("panel:workspace-tab-settings");
    expect(window.history.state.idx).toBe(indexBeforeClose);
    expect(container.querySelector('[data-testid="workspace-tab-ids"]')?.textContent).not.toContain("workspace-tab-home");
    await back();
    expect(new URLSearchParams(window.location.search).get("settingsCategory")).toBe("preferences");
    await forward();
    expect(new URLSearchParams(window.location.search).get("settingsCategory")).toBe("preferences");
  });

  it("opens View thread as a visible selected chat and Back restores Automations", async () => {
    await render();
    expect(container.querySelector('[data-testid="automations-panel"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="automation-open-thread-automation-a"]')!.click());
    await settle();
    const params = new URLSearchParams(window.location.search);
    // Chat is the canonical default route: the URL sync removes panel=chat.
    expect(params.has("panel")).toBe(false);
    expect(params.get("conversationId")).toBe(fixture.threadId);
    expect(params.get("conversationControllerId")).toBe(fixture.controllerId);
    expect(container.querySelector('[data-testid="visible-chat"]')?.getAttribute("data-conversation-id")).toBe(fixture.threadId);
    expect(container.querySelector('[data-testid="visible-chat"]')?.textContent).toBe("Autofix automation thread");
    expect(container.querySelector('[data-testid="selected-workspace-tab"]')?.textContent).toContain("conversation:");
    expect(container.querySelector('[data-testid="automations-panel"]')).toBeNull();
    await back();
    expect(new URLSearchParams(window.location.search).get("panel")).toBe("automations");
    expect(container.querySelector('[data-testid="automations-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="visible-chat"]')).toBeNull();
  });
  it("restores the exact empty-team settings target across reload and browser Back", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-empty-team-profile"]')!.click());
    await settle();
    expect(new URLSearchParams(window.location.search).get("settingsOrgId")).toBe(fixture.emptyTeamId);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.textContent).toBe(fixture.emptyTeamId);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-settings-tab")).toBe("org");
    // Recreate the app against the browser URL, retaining only actual persisted tabs.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.textContent).toBe(fixture.emptyTeamId);
    await back();
    expect(new URLSearchParams(window.location.search).get("panel")).toBe("automations");
    expect(container.querySelector('[data-testid="automations-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="visible-team-settings"]')).toBeNull();
  });
  it("Back after changing the team selector restores the original target and permissions", async () => {
    window.history.replaceState(null, "", `/studio?projectId=${fixture.projectId}&panel=settings&settingsTab=org&settingsOrgId=${fixture.projectTeamId}`);
    await render();
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.textContent).toBe(fixture.projectTeamId);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-role")).toBe("builder");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="select-empty-team"]')!.click());
    await settle();
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.textContent).toBe(fixture.emptyTeamId);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-role")).toBe("owner");
    await back();
    expect(new URLSearchParams(window.location.search).get("settingsOrgId")).toBe(fixture.projectTeamId);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.textContent).toBe(fixture.projectTeamId);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-role")).toBe("builder");
  });

  it("keeps an empty team's scope on Home and restores Team then workspace through browser Back", async () => {
    await render();
    const workParams = { projectId: fixture.projectId, panel: "automations", conversationId: "previous-chat" };
    expectRoute("automations", fixture.projectTeamId, workParams);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-empty-team-overview"]')!.click());
    await settle();
    const teamParams = { ...workParams, panel: "team", teamId: fixture.emptyTeamId };
    expectRoute("team", fixture.emptyTeamId, teamParams);
    expect(container.querySelector('[data-testid="visible-team-overview"]')?.textContent).toBe(fixture.emptyTeamId);
    expect(container.querySelector('[data-testid="automations-panel"]')).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-home"]')!.click());
    await settle();
    expectRoute("home", fixture.emptyTeamId, { ...teamParams, panel: "home" });
    expect(container.querySelector('[data-testid="visible-home"]')?.textContent).toBe(fixture.emptyTeamId);
    expect(container.querySelector('[data-testid="visible-team-overview"]')).toBeNull();

    await back();
    expectRoute("team", fixture.emptyTeamId, teamParams);
    expect(container.querySelector('[data-testid="visible-team-overview"]')).not.toBeNull();
    await back();
    expectRoute("automations", fixture.projectTeamId, workParams);
    expect(container.querySelector('[data-testid="automations-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="visible-home"]')).toBeNull();
    expect(container.querySelector('[data-testid="visible-team-overview"]')).toBeNull();
  });

  it("hydrates a direct empty-team overview without replacing its retained workspace project", async () => {
    window.history.replaceState(null, "", `/studio?projectId=${fixture.projectId}&panel=team&teamId=${fixture.emptyTeamId}`);
    await render();
    expectRoute("team", fixture.emptyTeamId, {
      projectId: fixture.projectId, panel: "team", teamId: fixture.emptyTeamId, conversationId: "previous-chat",
    });
    expect(container.querySelector('[data-testid="visible-team-overview"]')?.textContent).toBe(fixture.emptyTeamId);
  });

  it("uses settingsOrgId for team settings and restores the Home team before workspace navigation removes teamId", async () => {
    window.history.replaceState(null, "", `/studio?projectId=${fixture.projectId}&panel=home&teamId=${fixture.projectTeamId}`);
    await render();
    const homeParams = { projectId: fixture.projectId, panel: "home", teamId: fixture.projectTeamId, conversationId: "previous-chat" };
    expectRoute("home", fixture.projectTeamId, homeParams);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-empty-team-profile"]')!.click());
    await settle();
    expectRoute("settings", fixture.emptyTeamId, {
      projectId: fixture.projectId, panel: "settings", settingsTab: "org", settingsOrgId: fixture.emptyTeamId, settingsCategory: "profile", conversationId: "previous-chat",
    });
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-role")).toBe("owner");
    await back();
    expectRoute("home", fixture.projectTeamId, homeParams);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-workspace-automations"]')!.click());
    await settle();
    expectRoute("automations", fixture.projectTeamId, {
      projectId: fixture.projectId, panel: "automations", conversationId: "previous-chat",
    });
    expect(container.querySelector('[data-testid="navigation-scope"]')?.getAttribute("data-page")).toBe("workspace");
    await back();
    expectRoute("home", fixture.projectTeamId, homeParams);
  });

  it("honors an explicit workspace target after the team drawer queued a URL push on Home", async () => {
    window.history.replaceState(null, "", `/studio?projectId=${fixture.projectId}&panel=home&teamId=${fixture.projectTeamId}&workspaceTab=workspaces`);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="activate-retained-workspace"]')!.click());
    await settle();
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      projectId: fixture.projectId, conversationId: "previous-chat",
    });
    expect(container.querySelector('[data-testid="active-panel"]')?.textContent).toBe("chat");
    expect(container.querySelector('[data-testid="visible-chat"]')?.getAttribute("data-conversation-id")).toBe("previous-chat");
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      container.querySelector<HTMLButtonElement>('[data-testid="navigate-back"]')!.click();
      await popped;
    });
    await settle();
    expectRoute("home", fixture.projectTeamId, {
      projectId: fixture.projectId, panel: "home", teamId: fixture.projectTeamId, workspaceTab: "workspaces", conversationId: "previous-chat",
    });
  });

  it("collapses a mobile drawer and its space drill-in before pushing Team profile or Home once", async () => {
    await render();
    await click("use-mobile");
    const initialIndex = window.history.state.idx;
    const initialVisit = window.history.state.usr?.instafyVisitKey ?? window.history.state.key;
    const closed = () => expect(container.querySelector('[data-testid="drawer-view"]')?.textContent).toBe("closed");
    const teamProfileParams = {
      projectId: fixture.projectId, panel: "settings", settingsTab: "org", settingsCategory: "profile",
      settingsOrgId: fixture.emptyTeamId, conversationId: "previous-chat",
    };
    await click("open-drawer");
    expect(container.querySelector('[data-testid="drawer-view"]')?.textContent).toBe("sidebar");
    await click("drill-workspaces");
    expect(container.querySelector('[data-testid="drawer-view"]')?.textContent).toBe("workspace");
    expect(window.history.state.idx).toBe(initialIndex + 2);
    await click("open-empty-team-profile");
    closed();
    expect(window.history.state.idx).toBe(initialIndex + 1);
    expect(window.history.state.usr?.instafySidebar).toBeUndefined();
    expect(window.history.state.usr?.instafyVisitKey ?? window.history.state.key).not.toBe(initialVisit);
    expectRoute("settings", fixture.emptyTeamId, teamProfileParams);
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-settings-category")).toBe("profile");
    expect(container.querySelector('[data-testid="visible-team-settings"]')?.getAttribute("data-role")).toBe("owner");
    await back();
    closed();
    expectRoute("automations", fixture.projectTeamId, {
      projectId: fixture.projectId, panel: "automations", conversationId: "previous-chat",
    });
    await forward();
    closed();
    expectRoute("settings", fixture.emptyTeamId, teamProfileParams);

    await click("open-drawer");
    await click("drill-workspaces");
    expect(window.history.state.idx).toBe(initialIndex + 3);
    await click("open-home");
    closed();
    expect(window.history.state.idx).toBe(initialIndex + 2);
    expect(window.history.state.usr?.instafySidebar).toBeUndefined();
    const homeParams = {
      projectId: fixture.projectId, panel: "home", teamId: fixture.emptyTeamId, conversationId: "previous-chat",
    };
    expectRoute("home", fixture.emptyTeamId, homeParams);
    await back();
    closed();
    expectRoute("settings", fixture.emptyTeamId, teamProfileParams);
    await forward();
    closed();
    expectRoute("home", fixture.emptyTeamId, homeParams);
  });
});
