import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
vi.mock("../../sdk/instafy", () => ({ controllerClient: { projects: { create: createMock } } }));

import { createControllerSpace } from "../createControllerSpace";

const SPACE_ID = "11111111-2222-4333-8444-555555555555";
const ORG = { orgId: "org-1", orgSlug: "acme", orgName: "Acme" };

describe("createControllerSpace", () => {
  beforeEach(() => {
    createMock.mockReset().mockImplementation(async ({ projectName }) => ({ projectId: SPACE_ID, projectName: projectName ?? null }));
  });

  it("sends no name for a blank one, never placeholder words", async () => {
    for (const name of [undefined, "", "   "]) {
      await expect(createControllerSpace(name, ORG)).resolves.toEqual({
        projectInfo: { projectId: SPACE_ID, projectName: null },
        projectName: undefined,
      });
      expect(createMock).toHaveBeenLastCalledWith({ projectType: "customer", projectName: undefined, ...ORG });
    }
  });

  it("sends a typed name trimmed, and reports a failed create as no space", async () => {
    await expect(createControllerSpace(" Books 2026 ")).resolves.toMatchObject({ projectName: "Books 2026" });
    expect(createMock).toHaveBeenLastCalledWith({
      projectType: "customer", projectName: "Books 2026", orgId: null, orgSlug: null, orgName: null,
    });
    createMock.mockRejectedValueOnce(new Error("create project failed (500)"));
    await expect(createControllerSpace("Books 2026")).resolves.toEqual({ projectInfo: null, projectName: "Books 2026" });
  });
});
