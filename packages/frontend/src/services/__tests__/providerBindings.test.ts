import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());
const fetchLocalWorkspacePresenceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/workspaceFiles", () => ({
  readWorkspaceFileFromController: readMock,
  writeWorkspaceFileToController: writeMock,
}));

vi.mock("../runtimeController/origins", () => ({
  fetchLocalWorkspacePresence: fetchLocalWorkspacePresenceMock,
}));

import {
  PROVIDER_BINDINGS_PATH,
  readProjectProviderBindingStore,
  revokeProjectProviderBinding,
  upsertProjectProviderBinding,
} from "../runtimeController/providerBindings";

describe("provider bindings runtime controller helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    readMock.mockReset();
    writeMock.mockReset();
    fetchLocalWorkspacePresenceMock.mockReset();
    writeMock.mockResolvedValue({ ok: true });
    fetchLocalWorkspacePresenceMock.mockResolvedValue({
      path: "/home/example/git/demo",
      status: "online",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns an empty store when the bindings file does not exist", async () => {
    readMock.mockResolvedValue(null);

    await expect(
      readProjectProviderBindingStore({
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      version: 1,
      bindings: {},
    });

    expect(readMock).toHaveBeenCalledWith({
      projectId: "project-1",
      path: PROVIDER_BINDINGS_PATH,
      accessToken: null,
      runtimeId: null,
    });
  });

  it("upserts a binding and resolves rootUri from the linked local workspace", async () => {
    readMock.mockResolvedValue(null);

    const binding = await upsertProjectProviderBinding({
      projectId: "project-1",
      providerId: "demo",
      purpose: "Store learned robot state and summaries.",
      grantedCapabilities: ["project_content_write"],
      grantedPrefix: ".instafy/providers/demo/",
    });

    expect(binding).toMatchObject({
      providerId: "demo",
      projectId: "project-1",
      rootUri: "file:///home/example/git/demo",
      grantedCapabilities: ["project_content_write"],
      grantedPrefix: ".instafy/providers/demo/",
      status: "bound_read_write",
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });

    expect(fetchLocalWorkspacePresenceMock).toHaveBeenCalledWith({
      projectId: "project-1",
      accessToken: null,
    });

    const writeParams = writeMock.mock.calls[0]?.[0];
    expect(writeParams.projectId).toBe("project-1");
    expect(writeParams.path).toBe(PROVIDER_BINDINGS_PATH);

    const written = JSON.parse(writeParams.content) as {
      version: number;
      bindings: Record<string, { rootUri: string; status: string }>;
    };
    expect(written.version).toBe(1);
    expect(written.bindings.demo.rootUri).toBe("file:///home/example/git/demo");
    expect(written.bindings.demo.status).toBe("bound_read_write");
  });

  it("revokes an existing binding and persists the updated store", async () => {
    readMock.mockResolvedValue({
      isText: true,
      contentText: JSON.stringify({
        version: 1,
        bindings: {
          demo: {
            providerId: "demo",
            projectId: "project-1",
            rootUri: "file:///home/example/git/demo",
            grantedCapabilities: ["project_content_read", "project_content_write"],
            grantedPrefix: ".instafy/providers/demo/",
            purpose: "Store learned robot state.",
            status: "bound_read_write",
            createdAt: "2026-04-21T12:00:00.000Z",
            updatedAt: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
    });

    await expect(
      revokeProjectProviderBinding({
        projectId: "project-1",
        providerId: "demo",
      }),
    ).resolves.toBe(true);

    const writeParams = writeMock.mock.calls[0]?.[0];
    const written = JSON.parse(writeParams.content) as {
      bindings: Record<string, unknown>;
    };
    expect(written.bindings).toEqual({});
  });
});
