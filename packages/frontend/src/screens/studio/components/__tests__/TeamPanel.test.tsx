// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, ListMyActivityResult } from "../../../../services/runtimeController/activity";
import type { ControllerOrgMember, ControllerOrgMembersPage, ControllerOrgSummary } from "../../../../services/runtimeController/projects";
import { TeamPanel } from "../TeamPanel";

const mocks = vi.hoisted(() => ({
  userId: "user-a" as string | null,
  activeProjectId: "space-a",
  projectList: [
    { id: "space-a", name: "Space A", orgId: "team-a" },
    { id: "space-b", name: "Space B", orgId: "team-b" },
    { id: "personal-space", name: "Personal space", orgId: null },
  ],
  organizations: vi.fn(), members: vi.fn(), activity: vi.fn(), markSeen: vi.fn(),
  openSettings: vi.fn(), newSpace: vi.fn(), requestUrlNavigation: vi.fn(), openPanelTab: vi.fn(),
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }) }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => mocks }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => mocks }));
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({ onOpenOrgSettings: mocks.openSettings, onStartNewProject: mocks.newSpace }) }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  organizations: { list: mocks.organizations, listMembersPage: mocks.members },
  activity: { list: mocks.activity, markSeen: mocks.markSeen },
} }));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <main>{actions}{children}</main> }));

const teamA: ControllerOrgSummary = { id: "team-a", slug: "a", name: "Team A", role: "builder" };
const teamB: ControllerOrgSummary = { id: "team-b", slug: "b", name: "Team B", role: "viewer" };
const person: ControllerOrgMember = { userId: "user-a", fullName: "Ada", role: "builder", createdAt: "2026-09-08T06:00:00Z" };
const membersPage = (members: ControllerOrgMember[] = [person]): ControllerOrgMembersPage => ({ members, total: members.length, hasMore: false, nextCursor: null });
function item(id: string, overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id, kind: "run.finished", at: "2026-09-08T06:00:00Z",
    org: { id: "team-a", name: "Team A" }, project: { id: "space-a", name: "Space A" },
    conversation: { id: `thread-${id}`, title: `Work ${id}`, visibility: "shared", threadKind: null },
    run: { id: `run-${id}`, status: "success", promptId: null },
    actor: { kind: "agent", userId: "user-a", displayName: "Octo", handle: "octo", avatarSeed: null },
    title: `Work ${id}`, preview: `Update ${id}`, needsYou: false, live: false, seen: false, data: {}, ...overrides,
  };
}
const activityPage = (items: ActivityItem[]): ListMyActivityResult => ({ success: true, items, hasMore: false, nextBefore: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TeamPanel authorized work and navigation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  function Location() {
    const location = useLocation();
    return <output data-testid="location">{location.pathname}{location.search}</output>;
  }
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
  async function render(organizationId?: string | null) {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/studio?projectId=old-space&conversationId=old-local&conversationControllerId=old-controller&panel=team"]}>
          <TeamPanel organizationId={organizationId} /><Location />
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();
  }
  function section(name: string) { return container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!; }
  function button(text: string, scope: ParentNode = container) {
    return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent?.includes(text));
  }
  async function selectTeam(id: string) {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Team"]')!;
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }
  const location = () => new URL(container.querySelector('[data-testid="location"]')!.textContent!, "https://example.test");

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.clearAllMocks();
    mocks.userId = "user-a";
    mocks.activeProjectId = "space-a";
    mocks.organizations.mockReset().mockResolvedValue([teamA, teamB]);
    mocks.members.mockReset().mockResolvedValue(membersPage());
    mocks.activity.mockReset().mockResolvedValue(activityPage([item("1")]));
    mocks.markSeen.mockResolvedValue({ success: true });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("filters the authorized feed to this team, retains the viewer's private chat, and never marks it seen", async () => {
    mocks.activity.mockResolvedValue(activityPage([
      item("1"), item("2", { conversation: { id: "private-thread", title: "My private review", visibility: "private", threadKind: null } }),
      item("3", { org: { id: "team-b", name: "Team B" } }), item("4", { org: null }), item("5", { conversation: null }),
      item("6", { actor: { kind: "user", userId: "user-a", displayName: "Ada", handle: null, avatarSeed: null } }),
    ]));
    await render();
    expect(section("Team work").textContent).toContain("Work 1");
    expect(section("Team work").textContent).toContain("My private review");
    expect(section("Team work").textContent).toContain("Private chat");
    for (const id of ["3", "4", "5"]) expect(container.textContent).not.toContain(`Work ${id}`);
    expect(section("Agents in recent activity").querySelectorAll("li")).toHaveLength(1);
    expect(section("People").textContent).toContain("Ada · You");
    expect(button("Work 6", section("People"))).toBeDefined();
    expect(section("Team spaces").textContent).not.toContain("Space B");
    expect(section("Team spaces").textContent).not.toContain("Personal space");
    expect(mocks.activity).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
    expect(mocks.markSeen).not.toHaveBeenCalled();
  });

  it("opens the explicitly selected empty team without showing the old team's work or tools", async () => {
    mocks.organizations.mockResolvedValue([teamA, { ...teamB, role: "owner" }]);
    await render("team-b");
    expect(container.querySelector('select[aria-label="Team"]')).toBeNull();
    expect(section("Team work").textContent).not.toContain("Work 1");
    expect(button("Machines for Space A")).toBeUndefined();
    await act(async () => button("Team settings")!.click());
    expect(mocks.openSettings).toHaveBeenCalledWith("team-b");
    await act(async () => button("New space", section("Team spaces"))!.click());
    expect(mocks.newSpace).toHaveBeenCalledWith("team-b");
  });

  it("does not silently replace a revoked or unknown team with another accessible team", async () => {
    await render("revoked-team");
    expect(container.textContent).toContain("This team is not available to your account");
    expect(container.textContent).not.toContain("Work 1");
    expect(button("Team settings")).toBeUndefined();
    expect(mocks.members).not.toHaveBeenCalled();
  });

  it("keeps personal spaces separate from teams", async () => {
    await render(null);
    expect(section("Personal spaces").textContent).toContain("Personal space");
    expect(section("Personal spaces").textContent).not.toContain("Space A");
    expect(mocks.organizations).not.toHaveBeenCalled();
    expect(mocks.members).not.toHaveBeenCalled();
    await act(async () => button("New space")!.click());
    expect(mocks.newSpace).toHaveBeenCalledWith(null);
  });

  it("navigates to the exact work and space without retaining a previous chat route", async () => {
    await render();
    await act(async () => button("Work 1", section("Team work"))!.click());
    expect([...location().searchParams.entries()]).toEqual([["projectId", "space-a"], ["conversationControllerId", "thread-1"], ["panel", "chat"]]);
    await act(async () => button("Space A", section("Team spaces"))!.click());
    expect([...location().searchParams.entries()]).toEqual([["projectId", "space-a"], ["panel", "automations"]]);
  });

  it("keeps machine actions in the active space and settings scoped to the selected team", async () => {
    await render();
    await act(async () => button("Machines for Space A")!.click());
    expect(mocks.requestUrlNavigation).toHaveBeenCalledWith("push");
    expect(mocks.openPanelTab).toHaveBeenCalledWith("machines");
    expect(mocks.requestUrlNavigation.mock.invocationCallOrder[0]).toBeLessThan(mocks.openPanelTab.mock.invocationCallOrder[0]);
    await selectTeam("team-b");
    expect(button("Machines for")).toBeUndefined();
    expect(section("Team work").textContent).not.toContain("Work 1");
    await act(async () => button("Team settings")!.click());
    expect(mocks.openSettings).toHaveBeenCalledWith("team-b");
  });

  it.each(["owner", "admin", "builder"])("offers a scoped New space action for a team %s", async (role) => {
    mocks.organizations.mockResolvedValue([teamA, { ...teamB, role }]);
    await render();
    await selectTeam("team-b");
    await act(async () => button("New space", section("Team spaces"))!.click());
    expect(mocks.newSpace).toHaveBeenCalledExactlyOnceWith("team-b");
    expect(section("Team spaces").textContent).toContain("Available spaces");
  });

  it.each(["viewer", null, "unknown"])("does not offer space creation for unresolved or read-only role %s", async (role) => {
    mocks.organizations.mockResolvedValue([{ ...teamA, role }]);
    await render();
    expect(section("Team spaces").textContent).toContain("Space A");
    expect(button("New space")).toBeUndefined();
  });

  it("does not reuse member or private activity caches when another account opens the same team", async () => {
    mocks.activity.mockResolvedValueOnce(activityPage([item("1", { preview: "Account A private update" })]));
    mocks.members.mockResolvedValueOnce(membersPage([{ ...person, fullName: "Account A cached member" }]));
    await render();
    expect(container.textContent).toContain("Account A cached member");
    expect(container.textContent).toContain("Account A private update");

    const newMembers = deferred<ControllerOrgMembersPage>();
    const newActivity = deferred<ListMyActivityResult>();
    mocks.members.mockReturnValueOnce(newMembers.promise);
    mocks.activity.mockReturnValueOnce(newActivity.promise);
    mocks.userId = "user-b";
    await render();
    expect(container.textContent).not.toContain("Account A cached member");
    expect(container.textContent).not.toContain("Account A private update");
    await act(async () => {
      newMembers.resolve(membersPage([{ ...person, userId: "user-b", fullName: "Current viewer" }]));
      newActivity.resolve(activityPage([item("2", { preview: "Account B update" })]));
    });
    await settle();
    expect(container.textContent).toContain("Current viewer · You");
    expect(container.textContent).toContain("Account B update");
    expect(mocks.markSeen).not.toHaveBeenCalled();
  });

  it("ignores late responses from the previously selected team", async () => {
    const oldMembers = deferred<ControllerOrgMembersPage>();
    mocks.members.mockReturnValueOnce(oldMembers.promise);
    mocks.members.mockResolvedValueOnce(membersPage([{ ...person, fullName: "Team B member" }]));
    await render();
    await selectTeam("team-b");
    await act(async () => oldMembers.resolve(membersPage([{ ...person, fullName: "Late Team A member" }])));
    await settle();
    expect(section("People").textContent).toContain("Team B member");
    expect(container.textContent).not.toContain("Late Team A member");
  });

  it("hides cached member rows and totals when member access is rejected", async () => {
    await render();
    expect(section("People").textContent).toContain("Ada");
    mocks.members.mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["org-members", "team-a"] }); });
    await settle();
    expect(section("People").textContent).toContain("Unable to load members");
    expect(section("People").textContent).not.toContain("Ada");
    expect(section("People").textContent).not.toContain("(1)");
    expect(section("People").textContent).not.toContain("No matching members");
    expect(mocks.members).toHaveBeenLastCalledWith("team-a", expect.objectContaining({ throwOnError: true }));
  });

  it("hides team actions and cached content after organization access is rejected", async () => {
    await render();
    mocks.organizations.mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["team-overview-organizations", "user-a"] }); });
    await settle();
    expect(container.textContent).toContain("Unable to load your teams");
    expect(button("Team settings")).toBeUndefined();
    expect(container.textContent).not.toContain("Work 1");
    expect(container.textContent).not.toContain("You don’t belong to a team");
    expect(mocks.organizations).toHaveBeenLastCalledWith(expect.objectContaining({ throwOnError: true }));
  });

  it("shows an activity failure without claiming an empty team history", async () => {
    mocks.activity.mockResolvedValue({ success: false, error: "Forbidden" });
    await render();
    expect(section("Team work").textContent).toContain("Activity couldn’t refresh");
    expect(section("Team work").textContent).not.toContain("No activity for this team");
    expect(section("Agents in recent activity").textContent).not.toContain("No agent activity");
  });
});
