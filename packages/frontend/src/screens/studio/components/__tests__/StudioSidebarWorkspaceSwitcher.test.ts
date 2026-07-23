import { describe, expect, it } from "vitest";

import {
  getVisibleSidebarWorkspaceProjects,
  SIDEBAR_WORKSPACE_SWITCHER_DEFAULT_VISIBLE_LIMIT,
  SIDEBAR_WORKSPACE_SWITCHER_SEARCH_VISIBLE_LIMIT,
} from "../StudioSidebarWorkspaceSwitcher";

function buildProjects(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `project-${String(index).padStart(3, "0")}`,
  }));
}

describe("StudioSidebarWorkspaceSwitcher list limiting", () => {
  it("limits the default rendered project list", () => {
    const projects = buildProjects(SIDEBAR_WORKSPACE_SWITCHER_DEFAULT_VISIBLE_LIMIT + 25);
    const result = getVisibleSidebarWorkspaceProjects({
      projects,
      visibleLimit: SIDEBAR_WORKSPACE_SWITCHER_DEFAULT_VISIBLE_LIMIT,
    });

    expect(result.visibleProjects).toHaveLength(SIDEBAR_WORKSPACE_SWITCHER_DEFAULT_VISIBLE_LIMIT);
    expect(result.visibleProjects[0]?.id).toBe("project-000");
    expect(result.visibleProjects[result.visibleProjects.length - 1]?.id).toBe("project-039");
    expect(result.hiddenProjectCount).toBe(25);
  });

  it("uses the larger bounded list for searched results", () => {
    const projects = buildProjects(SIDEBAR_WORKSPACE_SWITCHER_SEARCH_VISIBLE_LIMIT + 15);
    const result = getVisibleSidebarWorkspaceProjects({
      projects,
      visibleLimit: SIDEBAR_WORKSPACE_SWITCHER_SEARCH_VISIBLE_LIMIT,
    });

    expect(result.visibleProjects).toHaveLength(SIDEBAR_WORKSPACE_SWITCHER_SEARCH_VISIBLE_LIMIT);
    expect(result.hiddenProjectCount).toBe(15);
  });
});
