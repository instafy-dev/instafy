// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerOrganizationDeleteResult } from "../../../services/runtimeController/projects";

const { deleteOrganization } = vi.hoisted(() => ({ deleteOrganization: vi.fn() }));
vi.mock("../../../sdk/instafy", () => ({ controllerClient: { organizations: { delete: deleteOrganization } } }));

import { PROJECT_ACCESS_REFRESH_EVENT } from "../../../projects/projectAccessEvents";
import { isProjectDeletedHere, unmarkProjectDeletedHere } from "../../../projects/projectDeletion";
import { deleteTeamFromThisTab } from "../teamDeletion";

const projects = [
  { id: "team-space-a", orgId: "team" },
  { id: "team-space-b", orgId: "team" },
  { id: "other-space", orgId: "other-team" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("deleting a team from this tab", () => {
  const accessChanged = vi.fn<(event: Event) => void>();
  const leave = vi.fn<(projectId: string | null) => void>();
  const removeTeamProjects = vi.fn<(orgId: string) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    window.addEventListener(PROJECT_ACCESS_REFRESH_EVENT, accessChanged);
  });
  afterEach(() => {
    window.removeEventListener(PROJECT_ACCESS_REFRESH_EVENT, accessChanged);
    projects.forEach((project) => unmarkProjectDeletedHere(project.id));
  });

  const start = () => {
    const answer = deferred<ControllerOrganizationDeleteResult>();
    deleteOrganization.mockReturnValueOnce(answer.promise);
    const outcome = deleteTeamFromThisTab({ orgId: "team", projects, leave, removeTeamProjects });
    return { answer, outcome };
  };
  const marks = () => projects.map((project) => isProjectDeletedHere(project.id));

  it("marks the team's spaces deleted here for as long as the request runs", async () => {
    const { answer, outcome } = start();
    expect(deleteOrganization).toHaveBeenCalledExactlyOnceWith("team");
    // The space notices that arrive meanwhile then leave the open space alone.
    expect(marks()).toEqual([true, true, false]);

    answer.resolve({ status: "deleted" });
    await expect(outcome).resolves.toEqual({ status: "deleted", nextProjectId: "other-space" });
    expect(leave).toHaveBeenCalledExactlyOnceWith("other-space");
    expect(removeTeamProjects).toHaveBeenCalledExactlyOnceWith("team");
    expect(marks()).toEqual([true, true, false]);
    expect(accessChanged.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([
      { projectId: null, deletedOrgId: "team" },
    ]);
  });

  it("clears the marks and stays put when the delete fails", async () => {
    const { answer, outcome } = start();
    answer.resolve({ status: "failed" });
    await expect(outcome).resolves.toEqual({ status: "failed" });
    expect(marks()).toEqual([false, false, false]);
    expect(leave).not.toHaveBeenCalled();
    expect(removeTeamProjects).not.toHaveBeenCalled();
    expect(accessChanged).not.toHaveBeenCalled();
  });

  it("leaves a team whose spaces are deleted but which is kept, as for a finished delete", async () => {
    const message = "This team's spaces are deleted, but some of their machines are still being released. Delete the team again in a few minutes to finish.";
    const { answer, outcome } = start();
    answer.resolve({ status: "incomplete", message });
    await expect(outcome).resolves.toEqual({ status: "incomplete", message, nextProjectId: "other-space" });
    expect(leave).toHaveBeenCalledExactlyOnceWith("other-space");
    expect(removeTeamProjects).toHaveBeenCalledExactlyOnceWith("team");
    // The spaces are gone, so the marks stay; the team is not, so no tab drops it.
    expect(marks()).toEqual([true, true, false]);
    expect(accessChanged.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([
      { projectId: null, deletedOrgId: null },
    ]);
  });

  it("goes to the Spaces page when this tab knows no space outside the team", async () => {
    deleteOrganization.mockResolvedValueOnce({ status: "deleted" });
    await expect(deleteTeamFromThisTab({
      orgId: "team", projects: projects.slice(0, 2), leave, removeTeamProjects,
    })).resolves.toEqual({ status: "deleted", nextProjectId: null });
    expect(leave).toHaveBeenCalledExactlyOnceWith(null);
    expect(removeTeamProjects).toHaveBeenCalledExactlyOnceWith("team");
  });
});
