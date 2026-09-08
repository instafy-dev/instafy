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
}) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => true }));
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
  });

  it("keeps the global rail and account while Home or collapse hides context", async () => {
    await render({ activePanel: "home" });
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-profile-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    await render({ collapsed: true });
    expect(container.querySelector('[data-testid="sidebar-organization-rail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    await render({ activePanel: "settings", hideContext: true });
    expect(container.querySelector('[data-testid="sidebar-context-navigation"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="sidebar-profile-menu"]')).toHaveLength(1);
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
