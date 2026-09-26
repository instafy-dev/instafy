// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioMobileContextHeader, type StudioMobileContextHeaderProps } from "../StudioMobileContextHeader";
import type { ProjectListItem } from "../../../../projects/useProjects";

const mocks = vi.hoisted(() => ({
  user: { email: "reader@example.test" } as { email: string } | null,
  profile: { fullName: "Alex Morgan", avatarUrl: "https://example.test/avatar.png" } as { fullName: string; avatarUrl: string | null } | null,
  refresh: vi.fn(async () => null),
  recency: vi.fn(() => ({ current: 100, sibling: 90, foreign: 80 })),
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../../../profile/ProfileProvider", () => ({ useProfile: () => ({ profile: mocks.profile }) }));
vi.mock("../../../../projects/useProjectRecency", () => ({ useProjectRecency: mocks.recency }));

vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({ userEmail: mocks.user?.email }) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: "current" }) }));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({ useRuntimeMenuOptions: () => ({ runtime: {}, runtimeOptions: [] }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../debug/useAppLogs", () => ({ useAppLogs: () => ({ logs: [], hasLogs: false, hasErrors: false, clearLogs: vi.fn() }) }));
vi.mock("../../../../updates/useAppUpdateMetadata", () => ({ useAppUpdateMetadata: () => ({ metadata: null, refresh: mocks.refresh }) }));
vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({ useDesktopReleaseLookup: () => ({ lookup: { status: "idle" } }) }));
vi.mock("../../../../updates/desktopAcquisition", () => ({ getAppAcquisitionTarget: () => "mobile" }));
vi.mock("../DevDiagnosticsMenu", () => ({ DevDiagnosticsMenu: () => null }));
vi.mock("../BuildLogOverlay", () => ({ BuildLogOverlay: () => null }));

const makeProject = (id: string, name: string, orgId: string | null): ProjectListItem => ({
  id, name, orgId, orgName: orgId ?? "Personal", state: {} as ProjectListItem["state"],
});

describe("StudioMobileContextHeader", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: StudioMobileContextHeaderProps;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    mocks.user = { email: "reader@example.test" };
    mocks.profile = { fullName: "Alex Morgan", avatarUrl: "https://example.test/avatar.png" };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      teamName: "Workshop", teamAvatarUrl: null, teamId: "team-a",
      projects: [makeProject("current", "Autofix", "team-a"), makeProject("sibling", "Core", "team-a"), makeProject("foreign", "Research", "team-b")],
      activeProjectId: "current", attentionCounts: { current: 2 }, homeActive: true, homeAttentionCount: 3,
      searchRef: createRef<HTMLButtonElement>(),
      onHome: vi.fn(), onSearch: vi.fn(), onProfile: vi.fn(), onTeam: vi.fn(), onSettings: vi.fn(),
      onSwitchTeam: vi.fn(), onBrowseSpaces: vi.fn(), onSpace: vi.fn(),
      onSupport: vi.fn(), onSignOut: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(nextProps = props) {
    props = nextProps;
    await act(async () => root.render(<StudioMobileContextHeader {...props} />));
  }
  function button(testId: string) {
    const element = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(element).not.toBeNull();
    return element!;
  }
  async function click(testId: string) {
    await act(async () => button(testId).click());
  }

  it("opens the shared account sheet without navigating and keeps Home and search separate", async () => {
    await render();
    expect(document.querySelectorAll('[aria-label="Home — all teams"]')).toHaveLength(1);
    expect(button("topbar-home-button").getAttribute("aria-current")).toBe("page");
    expect(button("topbar-home-button").getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button("topbar-home-button").getAttribute("aria-describedby")!)?.textContent).toBe("3 unread updates across teams");
    expect(container.querySelector('[data-testid="studio-mobile-home-attention"]')?.textContent).toBe("3");
    expect(props.searchRef.current).toBe(button("studio-mobile-search-trigger"));
    await click("topbar-home-button");
    await click("studio-mobile-search-trigger");
    await click("topbar-profile-button");
    expect(props.onHome).toHaveBeenCalledOnce();
    expect(props.onSearch).toHaveBeenCalledOnce();
    expect(props.onProfile).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="profile-account-sheet"]')).not.toBeNull();
    expect(button("profile-settings-button").textContent).toBe("Your settings");
    expect(button("profile-install-button").getAttribute("href")).toBe("/install#mobile");
    expect(mocks.refresh).toHaveBeenCalled();
    await click("profile-settings-button");
    expect(props.onProfile).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
    expect(props.onSwitchTeam).not.toHaveBeenCalled();
  });

  it("uses the same Support and sign-out actions in the compact account sheet", async () => {
    await render();
    await click("topbar-profile-button");
    await click("profile-support-button");
    expect(props.onSupport).toHaveBeenCalledOnce();
    expect(props.onProfile).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
    await click("topbar-profile-button");
    const signOut = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === "Sign out");
    expect(signOut).toBeDefined();
    await act(async () => signOut!.click());
    expect(props.onSignOut).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
  });

  it("uses singular update wording for Home and the current space", async () => {
    await render({ ...props, homeAttentionCount: 1, attentionCounts: { current: 1 } });
    expect(document.getElementById(button("topbar-home-button").getAttribute("aria-describedby")!)?.textContent).toBe("1 unread update across teams");
    expect(button("sidebar-space-button").getAttribute("aria-label")).toBe("Choose space: Autofix, 1 unread update");
    expect(container.querySelector('[data-testid="studio-mobile-home-attention"]')?.getAttribute("title")).toBe("1 unread update across teams");
  });

  it("shows only the selected team's recent spaces and routes an exact selection", async () => {
    await render();
    expect(mocks.recency).toHaveBeenCalledWith("reader@example.test");
    expect(button("sidebar-space-button").getAttribute("aria-label")).toContain("Autofix, 2 unread updates");
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-space-foreign"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-recent-space-current"]')).not.toBeNull();
    await click("sidebar-recent-space-sibling");
    expect(props.onSpace).toHaveBeenCalledExactlyOnceWith("sibling");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    expect(props.onHome).not.toHaveBeenCalled();
  });

  it("shows the saved space appearance in the mobile breadcrumb alongside its unread count", async () => {
    await render({ ...props, projects: props.projects.map(project => project.id === "current"
      ? { ...project, projectIcon: "📚", projectColor: "pink" } : project) });
    const identity = button("sidebar-space-button").querySelector('[data-testid="space-identity"]')!;
    expect(identity.textContent).toBe("📚");
    expect(identity.className).toContain("bg-pink-100");
    expect(button("sidebar-space-button").getAttribute("aria-label")).toBe("Choose space: Autofix, 2 unread updates");
    expect(container.querySelectorAll('[data-testid="sidebar-current-space-attention"]')).toHaveLength(1);
    await render({ ...props, teamId: "empty" });
    expect(button("sidebar-space-button").querySelector('[data-testid="space-identity"]')).toBeNull();
  });

  it("does not retain another team's active space or an open menu after switching teams", async () => {
    await render();
    await click("sidebar-space-button");
    await render({ ...props, teamId: "empty", teamName: "Empty team" });
    expect(button("sidebar-space-button").textContent).toContain("Choose space");
    expect(button("sidebar-space-button").textContent).not.toContain("Autofix");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')?.textContent).toContain("No recent spaces in this team.");
    await click("sidebar-browse-all-spaces");
    expect(props.onBrowseSpaces).toHaveBeenCalledOnce();
    expect(props.onSwitchTeam).not.toHaveBeenCalled();
  });

  it("opens the team chooser directly, including when settings are unavailable", async () => {
    await render();
    await click("sidebar-team-menu-trigger");
    expect(props.onSwitchTeam).toHaveBeenCalledOnce();
    expect(button("sidebar-team-menu-trigger").getAttribute("aria-label")).toContain("Choose team:");
    expect(document.querySelector('[data-testid="sidebar-team-menu-overview"]')).toBeNull();
    expect(props.onTeam).not.toHaveBeenCalled();
    expect(props.onSettings).not.toHaveBeenCalled();
    await render({ ...props, onSettings: undefined });
    await click("sidebar-team-menu-trigger");
    expect(document.querySelector('[data-testid="sidebar-team-menu-settings"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-team-menu-switch"]')).toBeNull();
    expect(props.onSwitchTeam).toHaveBeenCalledTimes(2);
  });

  it("uses the signed-in profile and changes initials when the account profile changes", async () => {
    await render();
    expect(button("topbar-profile-button").querySelector("img")?.src).toBe("https://example.test/avatar.png");
    await click("topbar-profile-button");
    mocks.profile = { fullName: "Sam Rivera", avatarUrl: null };
    mocks.user = { email: "sam@example.test" };
    await render({ ...props, homeActive: false, homeAttentionCount: 0 });
    expect(document.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
    expect(button("topbar-profile-button").querySelector("img")).toBeNull();
    expect(button("topbar-profile-button").textContent).toBe("SR");
    expect(mocks.recency).toHaveBeenLastCalledWith("sam@example.test");
    expect(button("topbar-home-button").hasAttribute("aria-current")).toBe(false);
    expect(container.querySelector('[data-testid="studio-mobile-home-attention"]')).toBeNull();
  });
});
