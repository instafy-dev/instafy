// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../store";

describe("project metadata refreshes", () => {
  const initialState = useWorkspaceStore.getState();
  const projectId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    useWorkspaceStore.setState(initialState, true);
    useWorkspaceStore.getState().createProject({
      projectId, projectName: "Saved space", orgId: "org-1", orgName: "Saved team",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useWorkspaceStore.setState(initialState, true);
  });

  it("does not publish or persist unchanged summary metadata", () => {
    const before = useWorkspaceStore.getState();
    const changed = vi.fn();
    const unsubscribe = useWorkspaceStore.subscribe(changed);
    const write = vi.spyOn(Storage.prototype, "setItem");

    before.setProjectOrg(projectId, { id: "org-1", name: "Saved team" });
    before.setProjectName(projectId, "  Saved space  ");

    expect(useWorkspaceStore.getState()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("still publishes and persists actual metadata changes", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const before = useWorkspaceStore.getState();
    before.setProjectOrg(projectId, { id: "org-2", name: "Renamed team" });
    before.setProjectName(projectId, " Renamed space ");

    const current = useWorkspaceStore.getState();
    expect(current.projects[projectId].org).toEqual({ id: "org-2", name: "Renamed team" });
    expect(current.projects[projectId].metadata.projectName).toBe("Renamed space");
    expect(current.state.metadata.projectName).toBe("Renamed space");
    expect(write).toHaveBeenCalledTimes(2);
  });
});
