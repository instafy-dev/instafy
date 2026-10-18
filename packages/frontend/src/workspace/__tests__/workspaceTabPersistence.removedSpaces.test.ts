// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../../store";
import {
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

describe("saved workspace tabs of spaces removed from the store", () => {
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

  it("drops a removed space's entry, and a copy loaded before cannot write it back", () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, DELETED_SPACE));
    const loadedBeforeRemoval = loadPersistedWorkspaceTabs()!;

    useWorkspaceStore.getState().removeProject(DELETED_SPACE);
    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);

    persistWorkspaceTabsState(loadedBeforeRemoval);
    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);

    // A space that returns to the store is saved again.
    useWorkspaceStore.getState().createProject({ projectId: DELETED_SPACE });
    persistWorkspaceTabsState(loadedBeforeRemoval);
    expect(savedSpaceIds()).toEqual([KEPT_SPACE, DELETED_SPACE]);
  });

  it("drops the entries of every space a deleted team held", () => {
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, TEAM_SPACE));

    useWorkspaceStore.getState().removeProjectsByOrgId(DELETED_TEAM);

    expect(savedSpaceIds()).toEqual([KEPT_SPACE]);
  });

  it("keeps the saved tabs when the removed space was never in the store", () => {
    const unknownSpace = "55555555-5555-4555-8555-555555555555";
    persistWorkspaceTabsState(savedTabs(KEPT_SPACE, unknownSpace));

    useWorkspaceStore.getState().removeProject(unknownSpace);

    expect(savedSpaceIds()).toEqual([KEPT_SPACE, unknownSpace].sort());
  });
});
