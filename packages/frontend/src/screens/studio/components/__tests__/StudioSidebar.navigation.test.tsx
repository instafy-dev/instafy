// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioSidebar } from "../StudioSidebar";
import type { StudioSidebarWorkspaceSwitcher } from "../StudioSidebarWorkspaceSwitcher";
import { StudioNavigationProvider, useStudioNavigation } from "../../../../navigation/useStudioNavigation";
import { useStudioHistory } from "../../../../navigation/useStudioHistory";
import { useMobileSidebarHistory } from "../../../useMobileSidebarHistory";
import { useRouteOwnedWorkspaceDrawer } from "../../../useRouteOwnedWorkspaceDrawer";

const mocks = vi.hoisted(() => ({
  projects: [{ id: "11111111-1111-4111-8111-111111111111", name: "Space A", orgId: null, orgName: "Personal" }],
  unseen: { id: "22222222-2222-4222-8222-222222222222", name: "Space B", orgId: null, orgName: "Personal" },
  beginProject: vi.fn(),
  legacySwitch: vi.fn(), legacyCreate: vi.fn(), workspaceChange: vi.fn(),
}));
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({ sidebarOpen: true, userEmail: "qa@example.test" }) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../../../../hooks/useTouchLikeInput", () => ({ useTouchLikeInput: () => false }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ projectList: mocks.projects, activeProjectId: mocks.projects[0].id, switchProject: mocks.legacySwitch, createProject: mocks.legacyCreate }) }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: ({ orgId }: { orgId: string | null }) => ({ mergedProjects: [...mocks.projects, mocks.unseen], remoteLoading: false, remoteDiscoveryResolved: true, remoteLoadedScope: orgId }) }));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({ useRuntimeMenuOptions: () => ({ runtime: {}, runtimeOptions: [] }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../profile/ProfileProvider", () => ({ useProfile: () => ({ profile: null }) }));
vi.mock("../../../../theme/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light", setThemeMode: vi.fn() }) }));
vi.mock("../../../../debug/useAppLogs", () => ({ useAppLogs: () => ({ logs: [], hasLogs: false, hasErrors: false, clearLogs: vi.fn() }) }));
vi.mock("../../../../updates/useAppUpdateMetadata", () => ({ useAppUpdateMetadata: () => ({ metadata: null, refresh: vi.fn() }) }));
vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({ useDesktopReleaseLookup: () => ({ lookup: { status: "idle" } }) }));
vi.mock("../../../../updates/desktopAcquisition", () => ({ getAppAcquisitionTarget: () => null }));
vi.mock("../../../../telemetry/studioPerformance", () => ({ studioPerformance: { begin: vi.fn(), beginProject: mocks.beginProject, cancel: vi.fn(), cancelOrganizationDiscovery: vi.fn() } }));
vi.mock("../../../../sdk/instafy", () => ({ runtimeControllerEnabled: false, controllerClient: { organizations: { list: vi.fn(), listMembers: vi.fn() }, projects: { listMembers: vi.fn() } } }));
vi.mock("../StudioSidebarAccountSection", () => ({ StudioSidebarAccountSection: () => null }));
vi.mock("../DevDiagnosticsMenu", () => ({ DevDiagnosticsMenu: () => null }));
vi.mock("../BuildLogOverlay", () => ({ BuildLogOverlay: () => null }));
vi.mock("../StudioSidebarWorkspaceSwitcher", () => ({
  StudioSidebarWorkspaceSwitcher: ({ onProjectMenuAction, onWorkspaceOrgChange }: ComponentProps<typeof StudioSidebarWorkspaceSwitcher>) => (
    <>
    <button data-testid="select-unseen-space" onClick={() => onProjectMenuAction(`project:${mocks.unseen.id}`)}>Space B</button>
    <button data-testid="select-current-space" onClick={() => onProjectMenuAction(`project:${mocks.projects[0].id}`)}>Current</button>
    <button data-testid="select-personal-team" onClick={() => onWorkspaceOrgChange("personal")}>Personal</button>
    <button data-testid="select-empty-team" onClick={() => onWorkspaceOrgChange("33333333-3333-4333-8333-333333333333")}>Empty team</button>
    </>
  ),
}));

const chatSearch = `?projectId=11111111-1111-4111-8111-111111111111&conversationId=chat-a`;
const workspaceSearch = `${chatSearch}&workspaceTab=workspaces`;
const noop = () => {};
const Icon = () => null;
const items: ComponentProps<typeof StudioSidebar>["items"] = [];
const moreItems: ComponentProps<typeof StudioSidebar>["moreItems"] = [{ id: "settings", label: "Settings", icon: Icon, accent: "" }];

// Actual Sidebar callback composition and Router history; external data and row
// discovery are synthetic. No controller, native plugin, or model is contacted.
function Harness({ teamNavigation = false }: { teamNavigation?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const history = useStudioHistory();
  const navigation = useStudioNavigation();
  const sidebar = useMobileSidebarHistory({ enabled: true, scopeKey: "qa:space-a" });
  const workspaceOpen = new URLSearchParams(location.search).get("workspaceTab") === "workspaces";
  const routeOwned = workspaceOpen && !sidebar.mobileSidebarOpen;
  const params = new URLSearchParams(location.search);
  const panel = params.get("panel");
  const { dismiss } = useRouteOwnedWorkspaceDrawer({ enabled: routeOwned, history });
  return <>
    <button data-testid="open-sidebar" onClick={() => sidebar.setMobileSidebarOpen(true)}>Open</button>
    <button data-testid="back" onClick={history.goBack}>Back</button>
    <button data-testid="forward" onClick={history.goForward}>Forward</button>
    <output data-testid="state">{JSON.stringify({ search: location.search, view: sidebar.mobileSidebarNavigation.view, index: window.history.state?.idx })}</output>
    <StudioNavigationProvider value={sidebar.runAfterSidebarClose}>
      {(sidebar.mobileSidebarOpen || routeOwned) && <StudioSidebar
        items={items} moreItems={moreItems} activePanel={panel === "home" || panel === "team" ? panel : "chat"} collapsed={false} mobileOverlay
        selectedOrgKey={params.get("teamId") ?? "personal"}
        onReturnToTeam={teamNavigation ? () => navigation({ kind: "conversation", projectId: mocks.projects[0].id }) : undefined}
        onActivateProject={teamNavigation ? projectId => navigation({ kind: "conversation", projectId }) : undefined}
        onOpenTeam={teamNavigation ? orgKey => { void navigate(`/studio?projectId=${mocks.projects[0].id}&panel=team&teamId=${orgKey}`); } : undefined}
        mobileNavigation={sidebar.mobileSidebarOpen ? sidebar.mobileSidebarNavigation : undefined}
        runSidebarAction={sidebar.runAfterSidebarClose}
        onSelect={panel => navigation({ kind: "panel", panel })}
        onSelectConversation={noop}
        workspaceSwitcherOpen={workspaceOpen} workspaceSwitcherPortalTarget={null}
        onWorkspaceSwitcherOpenChange={open => {
          mocks.workspaceChange(open);
          if (routeOwned && !open) dismiss();
          else if (open) sidebar.mobileSidebarNavigation.openView("workspace");
        }}
        onRequestClose={() => routeOwned ? dismiss() : sidebar.setMobileSidebarOpen(false)}
      />}
    </StudioNavigationProvider>
  </>;
}

describe("StudioSidebar navigation ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    // JSDOM lacks CSS.escape, which React Aria uses for keyboard menu focus.
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    window.history.replaceState({ idx: 0, key: "base" }, "", `/studio${chatSearch}`);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const state = () => JSON.parse(container.querySelector('[data-testid="state"]')!.textContent!) as { search: string; view: string | null; index: number };
  async function render(teamNavigation = false) { await act(async () => root.render(<BrowserRouter><Harness teamNavigation={teamNavigation} /></BrowserRouter>)); }
  async function click(id: string) {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(button).not.toBeNull(); await act(async () => button!.click());
  }
  async function openTeamPicker() {
    await click("sidebar-team-menu-trigger");
    await click("sidebar-team-menu-switch");
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
  }
  async function settle(assertion: () => void) {
    let failure: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      // JSDOM traverses history asynchronously. Flush each traversal in its
      // own act, rather than holding React's commit until a poll has passed.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      try { assertion(); return; } catch (error) { failure = error; }
    }
    throw failure;
  }

  it("pops exactly one drill-in level and opening More does not first dismiss the drawer", async () => {
    await render(); await click("open-sidebar"); await openTeamPicker();
    expect(state().view).toBe("workspace"); expect(state().index).toBe(2);
    const go = vi.spyOn(window.history, "go");
    await click("sidebar-project-switcher-back");
    expect(go.mock.calls).toEqual([[-1]]);
    await settle(() => expect(state().view).toBe("sidebar"));
    go.mockClear();
    await click("sidebar-nav-more");
    expect(go).not.toHaveBeenCalled();
    expect(mocks.workspaceChange).not.toHaveBeenCalled();
    expect(state().view).toBe("more"); expect(state().index).toBe(2);
  });

  it("collapses owned drawer history once before pushing an unseen space and preserves Back/Forward", async () => {
    await render(); await click("open-sidebar"); await openTeamPicker();
    const go = vi.spyOn(window.history, "go");
    await click("select-unseen-space");
    await settle(() => expect(new URLSearchParams(state().search).get("projectId")).toBe(mocks.unseen.id));
    expect(go.mock.calls).toEqual([[-2]]);
    expect(state()).toMatchObject({ view: null, index: 1 });
    expect(mocks.workspaceChange).not.toHaveBeenCalled();
    expect(mocks.legacyCreate).not.toHaveBeenCalled(); expect(mocks.legacySwitch).not.toHaveBeenCalled();
    expect(mocks.beginProject).toHaveBeenCalledWith(mocks.unseen.id, null, null);
    await click("back"); await settle(() => expect(state().search).toBe(chatSearch));
    expect(state().view).toBeNull();
    await click("forward"); await settle(() => expect(new URLSearchParams(state().search).get("projectId")).toBe(mocks.unseen.id));
  });

  it("pushes from a route-owned workspace without queuing a dismissal POP first", async () => {
    window.history.pushState({ idx: 1, key: "workspace" }, "", `/studio${workspaceSearch}`);
    await render(); const go = vi.spyOn(window.history, "go");
    await click("select-unseen-space");
    expect(new URLSearchParams(state().search).get("projectId")).toBe(mocks.unseen.id);
    expect(state().index).toBe(2); expect(state().view).toBeNull();
    expect(go).not.toHaveBeenCalled(); expect(mocks.workspaceChange).not.toHaveBeenCalled();
    await click("back"); await settle(() => expect(state().search).toBe(workspaceSearch));
    go.mockClear(); await click("sidebar-project-switcher-back");
    expect(go.mock.calls).toEqual([[-1]]); expect(mocks.workspaceChange).toHaveBeenCalledExactlyOnceWith(false);
    await settle(() => expect(state().search).toBe(chatSearch));
  });

  it("treats the current space in a route-owned drawer as a single dismissal", async () => {
    window.history.pushState({ idx: 1, key: "workspace" }, "", `/studio${workspaceSearch}`);
    await render(); const go = vi.spyOn(window.history, "go");
    await click("select-current-space");
    expect(go.mock.calls).toEqual([[-1]]);
    expect(mocks.workspaceChange).toHaveBeenCalledExactlyOnceWith(false);
    await settle(() => expect(state().search).toBe(chatSearch));
    expect(mocks.beginProject).not.toHaveBeenCalled();
  });

  it("returns from Home to the same team's work after collapsing the drawer branch once", async () => {
    const homeSearch = `${chatSearch}&panel=home&teamId=personal`;
    window.history.replaceState({ idx: 0, key: "home" }, "", `/studio${homeSearch}`);
    await render(true); await click("open-sidebar"); await openTeamPicker();
    const go = vi.spyOn(window.history, "go");
    await click("select-personal-team");
    await settle(() => {
      expect(state().view).toBeNull();
      expect(new URLSearchParams(state().search).get("panel")).toBeNull();
    });
    expect(go.mock.calls).toEqual([[-2]]);
    expect(state().index).toBe(1);
    expect(new URLSearchParams(state().search).get("projectId")).toBe(mocks.projects[0].id);
    expect(mocks.legacyCreate).not.toHaveBeenCalled(); expect(mocks.legacySwitch).not.toHaveBeenCalled();
    await click("back"); await settle(() => expect(state().search).toBe(homeSearch));
    expect(state().view).toBeNull();
    await click("forward"); await settle(() => expect(new URLSearchParams(state().search).get("panel")).toBeNull());
  });

  it("reactivates Current from another team's route-owned picker without a dismissal POP", async () => {
    const otherTeamPicker = `${chatSearch}&panel=team&teamId=33333333-3333-4333-8333-333333333333&workspaceTab=workspaces`;
    window.history.pushState({ idx: 1, key: "other-team-picker" }, "", `/studio${otherTeamPicker}`);
    await render(true);
    const go = vi.spyOn(window.history, "go");
    await click("select-current-space");
    expect(new URLSearchParams(state().search).get("panel")).toBeNull();
    expect(new URLSearchParams(state().search).get("projectId")).toBe(mocks.projects[0].id);
    expect(state()).toMatchObject({ view: null, index: 2 });
    expect(go).not.toHaveBeenCalled();
    expect(mocks.workspaceChange).not.toHaveBeenCalled();
    await click("back"); await settle(() => expect(state().search).toBe(otherTeamPicker));
  });

  it("opens an empty team's overview and reactivates the loaded space without dismissing to the wrong scope", async () => {
    await render(true); await click("open-sidebar"); await openTeamPicker();
    const go = vi.spyOn(window.history, "go");
    await click("select-empty-team");
    await settle(() => expect(new URLSearchParams(state().search).get("panel")).toBe("team"));
    expect(new URLSearchParams(state().search).get("teamId")).toBe("33333333-3333-4333-8333-333333333333");
    expect(state()).toMatchObject({ view: null, index: 1 });
    expect(go.mock.calls).toEqual([[-2]]);
    const overviewSearch = state().search;
    await click("open-sidebar"); await openTeamPicker();
    go.mockClear(); await click("select-current-space");
    await settle(() => expect(new URLSearchParams(state().search).get("panel")).toBeNull());
    expect(state()).toMatchObject({ view: null, index: 2 });
    expect(go.mock.calls).toEqual([[-2]]);
    expect(new URLSearchParams(state().search).get("projectId")).toBe(mocks.projects[0].id);
    expect(mocks.legacyCreate).not.toHaveBeenCalled(); expect(mocks.legacySwitch).not.toHaveBeenCalled();
    await click("back"); await settle(() => expect(state().search).toBe(overviewSearch));
    await click("back"); await settle(() => expect(state().search).toBe(chatSearch));
  });
});
