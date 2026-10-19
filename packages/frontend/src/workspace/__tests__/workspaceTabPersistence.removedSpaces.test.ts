// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../store";
import {
  forgetWorkspaceTabsForProjects,
  loadPersistedWorkspaceTabs,
  persistWorkspaceTabsState,
  type PersistedWorkspaceTabsState,
} from "../workspaceTabPersistence";

const KEPT_SPACE = "11111111-1111-4111-8111-111111111111";
const DELETED_SPACE = "22222222-2222-4222-8222-222222222222";
const TEAM_SPACE = "33333333-3333-4333-8333-333333333333";
const DELETED_TEAM = "44444444-4444-4444-8444-444444444444";

function savedTabs(...projectIds: string[]): PersistedWorkspaceTabsState {
  return {
    projects: Object.fromEntries(projectIds.map((projectId) => [projectId, {
      conversations: [`chat-${projectId}`],
      activeConversationId: `chat-${projectId}`,
    }])),
  };
}

const savedSpaceIds = () => Object.keys(loadPersistedWorkspaceTabs()?.projects ?? {}).sort();

describe("saved workspace tabs of spaces that leave the store", () => {
  const initialState = useWorkspaceStore.getState();

  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState(initialState, true);
    const store = useWorkspaceStore.getState();
    store.createProject({ projectId: KEPT_SPACE, projectName: "Kept" });
    store.createProject({ projectId: DELETED_SPACE, projectName: "My bookkeeping" });
    store.createProject({ projectId: TEAM_SPACE, projectName: "Team space", orgId: DELETED_TEAM, orgName: "Old team" });
  });

  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    localStorage.clear();
  });

  it("keeps a space's saved tabs when it leaves the store only because an access check failed", () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, DELETED_SPACE, TEAM_SPACE));
    const loadedBefore = loadPersistedWorkspaceTabs()!;

    // How the access checks remove a space on a 401, 403 or 404, which can
    // be a token refresh in flight rather than a deletion.
    useWorkspaceStore.getState().removeProject(DELETED_SPACE);
    useWorkspaceStore.getState().removeProject(TEAM_SPACE, { openFallback: false });
    expect(savedSpaceIds()).toEqual([KEPT_SPACE, DELETED_SPACE, TEAM_SPACE].sort());

    // Nor do later writes leave it out.
    persistWorkspaceTabsState(loadedBefore);
    expect(savedSpaceIds()).toEqual([KEPT_SPACE, DELETED_SPACE, TEAM_SPACE].sort());
  });

  it("keeps a team's spaces' saved tabs when the team leaves the store without a deletion", () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, TEAM_SPACE));

    useWorkspaceStore.getState().removeProjectsByOrgId(DELETED_TEAM);

    expect(savedSpaceIds()).toEqual([KEPT_SPACE, TEAM_SPACE].sort());
  });

  it("drops a deleted space's entry, and a copy loaded before cannot write it back", () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, DELETED_SPACE));
    const loadedBeforeDeletion = loadPersistedWorkspaceTabs()!;

    useWorkspaceStore.getState().removeProject(DELETED_SPACE, { forgetSavedTabs: true });
    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);

    persistWorkspaceTabsState(loadedBeforeDeletion);
    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);

    // A space created again in this browser is saved again.
    useWorkspaceStore.getState().createProject({ projectId: DELETED_SPACE });
    persistWorkspaceTabsState(loadedBeforeDeletion);
    expect(savedSpaceIds()).toEqual([KEPT_SPACE, DELETED_SPACE]);
  });

  it("keeps another tab of this browser from writing a deleted space's entry back", async () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, DELETED_SPACE));
    const loadedByOtherTab = loadPersistedWorkspaceTabs()!;

    useWorkspaceStore.getState().removeProject(DELETED_SPACE, { forgetSavedTabs: true });

    // Another tab has its own copy of the module and never saw the deletion.
    vi.resetModules();
    const otherTab = await import("../workspaceTabPersistence");
    otherTab.persistWorkspaceTabsState(loadedByOtherTab);

    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);
  });

  it("drops the entries of every space a deleted team held", () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, TEAM_SPACE));

    useWorkspaceStore.getState().removeProjectsByOrgId(DELETED_TEAM, { forgetSavedTabs: true });

    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);
  });

  it("drops a deleted space this tab's store never held", () => {
    const unknownSpace = "55555555-5555-4555-8555-555555555555";
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, unknownSpace));

    useWorkspaceStore.getState().removeProject(unknownSpace, { forgetSavedTabs: true });

    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);
  });

  it("remembers only the latest 50 deleted spaces", () => {
    const deletedIds = Array.from({ length: 55 }, (_, index) => `deleted-${index}`);
    deletedIds.forEach((projectId) => forgetWorkspaceTabsForProjects([projectId]));

    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, "deleted-0", "deleted-4", "deleted-5", "deleted-54"));

    // The oldest five fell off the list; the rest stay out.
    expect(savedSpaceIds()).toEqual([KEPT_SPACE, "deleted-0", "deleted-4"].sort());
  });
});
