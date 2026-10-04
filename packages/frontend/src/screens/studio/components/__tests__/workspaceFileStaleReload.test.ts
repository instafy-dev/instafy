import { beforeEach, describe, expect, it, vi } from "vitest";
import { controllerClient } from "../../../../sdk/instafy";
import { prepareStaleWorkspaceFileReload } from "../workspaceFileStaleReload";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { revertPaths: vi.fn() } } },
}));

const notice = { projectId: "space-a", path: "README.md", label: "README.md", baseText: "a", localText: "b", detectedAt: 1 };

describe("prepareStaleWorkspaceFileReload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing for a conflict on the space", async () => {
    expect(await prepareStaleWorkspaceFileReload(notice, "space-a")).toBe(true);
    expect(controllerClient.workspace.git.revertPaths).not.toHaveBeenCalled();
  });

  it("discards the Desktop folder's copy on that origin first", async () => {
    vi.mocked(controllerClient.workspace.git.revertPaths).mockResolvedValue({ ok: true, conflict: false } as never);
    expect(await prepareStaleWorkspaceFileReload({ ...notice, variant: "desktop", originId: "desk-1" }, "space-a")).toBe(true);
    expect(controllerClient.workspace.git.revertPaths).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", paths: ["README.md"], routing: "default", originId: "desk-1",
    });
  });

  it("keeps the card when the folder copy could not be discarded", async () => {
    vi.mocked(controllerClient.workspace.git.revertPaths).mockResolvedValue({ ok: false, conflict: false } as never);
    expect(await prepareStaleWorkspaceFileReload({ ...notice, variant: "desktop" }, "space-a")).toBe(false);
    vi.mocked(controllerClient.workspace.git.revertPaths).mockRejectedValue(new Error("offline"));
    expect(await prepareStaleWorkspaceFileReload({ ...notice, variant: "desktop" }, "space-a")).toBe(false);
  });
});
