import { describe, expect, it } from "vitest";

import {
  filterUnavailableProjectPickerProjects,
  getVisibleProjectPickerProjects,
  PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT,
  PROJECT_PICKER_SEARCH_VISIBLE_LIMIT,
} from "../ProjectPickerPanel";

function buildProjects(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `project-${String(index).padStart(3, "0")}`,
  }));
}

describe("ProjectPickerPanel list limiting", () => {
  it("limits the default rendered list", () => {
    const projects = buildProjects(PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT + 20);
    const result = getVisibleProjectPickerProjects({
      activeProjectId: null,
      projects,
      visibleLimit: PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT,
    });

    expect(result.visibleProjects).toHaveLength(PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT);
    expect(result.visibleProjects[0]?.id).toBe("project-000");
    expect(result.visibleProjects[result.visibleProjects.length - 1]?.id).toBe("project-039");
    expect(result.hiddenProjectCount).toBe(20);
  });

  it("keeps the active project visible when it is beyond the default limit", () => {
    const projects = buildProjects(PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT + 20);
    const result = getVisibleProjectPickerProjects({
      activeProjectId: "project-055",
      projects,
      visibleLimit: PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT,
    });

    expect(result.visibleProjects).toHaveLength(PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT);
    expect(result.visibleProjects[0]?.id).toBe("project-055");
    expect(result.visibleProjects.some((project) => project.id === "project-055")).toBe(true);
    expect(result.hiddenProjectCount).toBe(20);
  });

  it("allows a larger bounded list for searched results", () => {
    const projects = buildProjects(PROJECT_PICKER_SEARCH_VISIBLE_LIMIT + 10);
    const result = getVisibleProjectPickerProjects({
      activeProjectId: null,
      projects,
      visibleLimit: PROJECT_PICKER_SEARCH_VISIBLE_LIMIT,
    });

    expect(result.visibleProjects).toHaveLength(PROJECT_PICKER_SEARCH_VISIBLE_LIMIT);
    expect(result.hiddenProjectCount).toBe(10);
  });
});

describe("filterUnavailableProjectPickerProjects", () => {
  it("removes the requested space when access resolution says it is unavailable", () => {
    const result = filterUnavailableProjectPickerProjects({
      unavailableProjectId: "project-stale",
      projects: [
        { id: "project-stale" },
        { id: "project-good" },
      ],
    });

    expect(result.map((project) => project.id)).toEqual(["project-good"]);
  });

  it("keeps the list unchanged when no unavailable project is known", () => {
    const projects = [{ id: "project-one" }, { id: "project-two" }];

    expect(
      filterUnavailableProjectPickerProjects({
        unavailableProjectId: null,
        projects,
      }),
    ).toBe(projects);
  });
});
