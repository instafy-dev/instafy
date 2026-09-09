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
  orgs: [
    { id: "org-a", name: "Alpha", slug: "alpha", role: "builder", avatarUrl: null as string | null },
    { id: "org-b", name: "Empty team", slug: "empty", role: "owner", avatarUrl: null as string | null },
    { id: "org-c", name: "Charlie", slug: "charlie", role: "builder", avatarUrl: null as string | null },
  ],
  userEmail: "member@example.test",
  desktop: true,
  onToggleSidebar: vi.fn(),
  switchProject: vi.fn(), createProject: vi.fn(), onSettings: vi.fn(), onNewSpace: vi.fn(),
  copyTunnelDetails: vi.fn(), showStatus: vi.fn(), refresh: vi.fn(), retry: vi.fn(),
  discoveryError: null as string | null, discoveryResolved: true, discoveryRefreshing: false,
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({
  projectList: fixture.projects, activeProjectId: "space-a", switchProject: fixture.switchProject, createProject: fixture.createProject,
}) }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: ({ orgId }: { orgId: string | null }) => ({
  mergedProjects: fixture.projects, remoteLoading: false, remoteLoadedScope: fixture.discoveryResolved ? orgId : null,
  remoteDiscoveryResolved: fixture.discoveryResolved, remoteError: fixture.discoveryError,
  remoteRefreshing: fixture.discoveryRefreshing, retryRemoteProjects: fixture.retry,
}) }));
vi.mock("../../../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../../../sdk/instafy")>("../../../../sdk/instafy");
  return { ...actual, runtimeControllerEnabled: true, controllerClient: {
    ...actual.controllerClient, organizations: { ...actual.controllerClient.organizations, list: async () => fixture.orgs },
  } };
});
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({
  userEmail: fixture.userEmail, hasLogs: false, sidebarOpen: true,
  onOpenOrgSettings: fixture.onSettings, onStartNewProject: fixture.onNewSpace,
  onToggleSidebar: fixture.onToggleSidebar,
}) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => fixture.desktop }));
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

describe("StudioSidebar organization navigation", () => {
  let container: HTMLDivElement;
  let portal: HTMLDivElement;
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
  const click = async (testId: string) => act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click());
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.clearAllMocks();
    fixture.userEmail = "member@example.test";
    fixture.desktop = true;
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: null }));
    fixture.discoveryError = null;
    fixture.discoveryResolved = true;
    fixture.discoveryRefreshing = false;
    container = document.createElement("div");
    portal = document.createElement("div");
    document.body.append(container, portal);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portal.remove();
    vi.restoreAllMocks();
  });

  it("keeps the global rail and account while Home and account pages hide context", async () => {
    await render({ activePanel: "home" });
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-profile-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    await render({ activePanel: "settings", hideContext: true });
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="sidebar-profile-menu"]')).toHaveLength(1);
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
    expect(container.querySelector('[aria-label="Open Alpha overview"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="sidebar-space-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-choose-space"]')?.getAttribute("title")).toBe("Browse spaces");
    expect(container.querySelector('[data-testid="sidebar-new-space"]')?.getAttribute("title")).toBe("New space");
    await click("sidebar-nav-team");
    expect(onOpenTeam).toHaveBeenCalledWith("org-b");
    await click("sidebar-settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("org-b");
    await click("sidebar-new-space");
    expect(fixture.onNewSpace).toHaveBeenCalledWith("org-b");
    await click("sidebar-choose-space");
    await render({ ...props, workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(portal.textContent).not.toContain("Core");
    await render({ ...props, activePanel: "settings" });
    expect(container.querySelector('[data-testid="sidebar-settings"] > span')?.className).toContain("border-primary-200");
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
    expect(container.querySelector('[data-testid="sidebar-nav-more"]')).not.toBeNull();
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
    await click("sidebar-settings");
    expect(fixture.onSettings).toHaveBeenCalledWith("unavailable-team");
  });

  it("keeps the narrow layout as a labeled closeable drawer", async () => {
    fixture.desktop = false;
    await render({ mobileOverlay: true });
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')?.textContent).toContain("Team overview");
    expect(container.querySelector('[data-testid="sidebar-drawer-toggle"]')?.getAttribute("aria-label")).toBe("Close navigation");
    await click("sidebar-drawer-toggle");
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(fixture.onToggleSidebar).not.toHaveBeenCalled();
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
    expect(container.querySelector('[data-testid="sidebar-space-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-no-selected-space"]')).not.toBeNull();
    await click("sidebar-settings");
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

  it("opens explicit overview from the inner heading and limits its picker to spaces", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Alpha overview"]')?.click());
    expect(onOpenTeam).toHaveBeenCalledWith("org-a");
    await click("sidebar-space-button");
    await render({ workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).toBeNull();
    expect(portal.textContent).toContain("Spaces");
    await render({ workspaceSwitcherOpen: false });
    await click("sidebar-browse-teams");
    await render({ workspaceSwitcherOpen: true });
    expect(portal.querySelector('[data-testid="sidebar-org-selector"]')).not.toBeNull();
  });

  it("does not expose the previous team's settings or tools in Personal scope", async () => {
    await render({ selectedOrgKey: "personal", activePanel: "team" });
    expect(container.querySelector('[data-testid="sidebar-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-profile-menu"]')).not.toBeNull();
    expect(fixture.onSettings).not.toHaveBeenCalled();
  });

  it("publishes resolved selected-team metadata only when its identity changes", async () => {
    const onActiveTeamChange = vi.fn();
    await render({ onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", avatarUrl: null });
    const initialCalls = onActiveTeamChange.mock.calls.length;
    await render({ collapsed: true, onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls);
    await render({ selectedOrgKey: "org-b", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-b", name: "Empty team", avatarUrl: null });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls + 1);
  });

  it("publishes selected-team avatar changes and clears images for other scopes", async () => {
    const onActiveTeamChange = vi.fn();
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: `https://images.example.test/${org.id}.png` }));
    await render({ onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", avatarUrl: "https://images.example.test/org-a.png" });
    const initialCalls = onActiveTeamChange.mock.calls.length;
    await render({ collapsed: true, onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls);
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: org.id === "org-a" ? "https://images.example.test/updated.png" : org.avatarUrl }));
    await act(async () => { window.dispatchEvent(new Event("instafy:orgs-updated")); });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", avatarUrl: "https://images.example.test/updated.png" });
    expect(onActiveTeamChange).toHaveBeenCalledTimes(initialCalls + 1);
    fixture.orgs = fixture.orgs.map((org) => ({ ...org, avatarUrl: org.id === "org-a" ? null : org.avatarUrl }));
    await act(async () => { window.dispatchEvent(new Event("instafy:orgs-updated")); });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", avatarUrl: null });
    await render({ selectedOrgKey: "org-b", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-b", name: "Empty team", avatarUrl: "https://images.example.test/org-b.png" });
    await render({ selectedOrgKey: "org-unknown", onActiveTeamChange });
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-unknown", name: "Team", avatarUrl: null });
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
    expect(onActiveTeamChange).toHaveBeenLastCalledWith({ key: "org-a", name: "Alpha", avatarUrl: null });
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
