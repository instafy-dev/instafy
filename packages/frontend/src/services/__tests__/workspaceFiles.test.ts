import { beforeEach, describe, expect, it, vi } from "vitest";

const requestOriginAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/core", () => ({
  normalizeOriginEndpointForClient: (value: string) => value,
  runtimeControllerEnabled: true,
}));

vi.mock("../runtimeController/origins", () => ({
  requestOriginAccessToken: requestOriginAccessTokenMock,
}));

vi.mock("../runtimeController/workspaceApply", () => ({
  applyWorkspaceChangesViaOrigin: vi.fn(),
}));

import { readWorkspaceFileFromController } from "../runtimeController/workspaceFiles";

describe("readWorkspaceFileFromController", () => {
  beforeEach(() => {
    requestOriginAccessTokenMock.mockReset();
    vi.restoreAllMocks();
  });

  it("uses the read timeout when minting origin access for previews", async () => {
    requestOriginAccessTokenMock.mockResolvedValue({
      originId: "origin-1",
      endpoint: "http://runtime-origin.test",
      mode: "hosted",
      token: "origin-token",
      expiresIn: 60,
      scopes: ["fs.read"],
      leaseId: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          path: "repos/instafy-dev-demo/TODO.md",
          size: 5,
          encoding: "base64",
          mimeType: "text/markdown",
          content_base64: "SGVsbG8=",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await readWorkspaceFileFromController({
      projectId: "project-1",
      path: "repos/instafy-dev-demo/TODO.md",
      runtimeId: null,
      timeoutMs: 5000,
    });

    expect(result?.contentText).toBe("Hello");
    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith({
      projectId: "project-1",
      protocol: "http",
      scopes: ["fs.read"],
      originId: null,
      preferRuntime: null,
      accessToken: null,
      timeoutMs: 5000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
