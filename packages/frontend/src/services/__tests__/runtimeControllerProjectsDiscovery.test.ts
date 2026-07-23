import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/core", () => ({
  controllerBaseUrl: "http://controller.test",
  normalizeUuidParam: (value: string | null | undefined) => value ?? null,
  readControllerError: vi.fn(),
  resolveControllerAccessToken: resolveControllerAccessTokenMock,
  runtimeControllerEnabled: true,
}));

import { listControllerProjects } from "../runtimeController/projects";

describe("listControllerProjects accessible discovery", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the accessible-project endpoint when no organization is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "11111111-1111-4111-8111-111111111111",
            projectName: "Directly shared space",
            orgId: "22222222-2222-4222-8222-222222222222",
            orgName: "External team",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listControllerProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: "11111111-1111-4111-8111-111111111111",
        projectName: "Directly shared space",
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledWith("http://controller.test/projects", {
      headers: { authorization: "Bearer token-123" },
    });
  });

  it("preserves the organization-scoped endpoint for explicit callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ projects: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await listControllerProjects({ orgId: "org-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://controller.test/orgs/org-1/projects",
      { headers: { authorization: "Bearer token-123" } },
    );
  });
});
