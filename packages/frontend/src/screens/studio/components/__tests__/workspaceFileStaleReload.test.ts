import { beforeEach, describe, expect, it, vi } from "vitest";
import { controllerClient } from "../../../../sdk/instafy";
import type { CodeFile, CodeWorkspace } from "../../../../types";
import { isFileBufferDirty } from "../filesVersioning";
import { loadLatestIntoStaleBuffer, prepareStaleWorkspaceFileReload } from "../workspaceFileStaleReload";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { revertPaths: vi.fn() }, files: { readAt: vi.fn() } } },
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

describe("loadLatestIntoStaleBuffer", () => {
  beforeEach(() => vi.clearAllMocks());

  const other: CodeFile = { id: "notes.md", path: "notes.md", label: "notes.md", generated: "n", modified: "n edited" };

  function workspaceWith(buffer: CodeFile) {
    let workspace = { files: [buffer, other], activeFileId: "notes.md" } as unknown as CodeWorkspace;
    const update = vi.fn<(updater: (current: CodeWorkspace) => CodeWorkspace, options?: { recordHistory?: boolean }) => void>(
      (updater) => {
        workspace = updater(workspace);
      },
    );
    return { current: () => workspace, update };
  }

  function served(contentText: string, extra: Record<string, unknown> = {}) {
    return {
      ok: true,
      file: { path: "check.md", size: contentText.length, encoding: "utf8", mimeType: "text/markdown", contentBase64: "", contentText, isText: true, ...extra },
    };
  }

  it("puts the space's version into the buffer and clears its edits with no Files viewer open", async () => {
    const store = workspaceWith({
      id: "check.md", path: "check.md", label: "check.md", generated: "base", modified: "mine",
      baseRev: "rev-1", blobOid: "blob-1", originId: "gateway", readAt: 1,
    });
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValue(
      served("theirs", { rev: "rev-2", blobOid: "blob-2", originId: "gateway" }) as never,
    );

    const loaded = await loadLatestIntoStaleBuffer({
      projectId: "space-a",
      path: "check.md",
      versioning: { mode: "stateless", originId: "gateway" },
      runtimeId: "runtime-1",
      updateWorkspace: store.update,
    });

    expect(loaded).toBe(true);
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", path: "check.md", routing: "default", originId: "gateway",
    });
    const [buffer, untouched] = store.current().files;
    expect(buffer).toMatchObject({ generated: "theirs", modified: "theirs", baseRev: "rev-2", blobOid: "blob-2", originId: "gateway" });
    expect(isFileBufferDirty(buffer!)).toBe(false);
    expect(untouched).toBe(other);
    expect(store.update).toHaveBeenCalledWith(expect.any(Function), { recordHistory: false });
  });

  it("reads through the runtime in legacy mode and keeps no read ids", async () => {
    const store = workspaceWith({ id: "check.md", path: "check.md", label: "check.md", generated: "base", modified: "mine" });
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValue(served("theirs", { originId: "runtime-origin" }) as never);

    expect(
      await loadLatestIntoStaleBuffer({
        projectId: "space-a",
        path: "check.md",
        versioning: { mode: "legacy", originId: "gateway" },
        runtimeId: "runtime-1",
        updateWorkspace: store.update,
      }),
    ).toBe(true);
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", path: "check.md", runtimeId: "runtime-1",
    });
    expect(store.current().files[0]).toEqual({
      id: "check.md", path: "check.md", label: "check.md", mimeType: "text/markdown", size: 6, generated: "theirs", modified: "theirs",
    });
  });

  it("leaves the buffer alone when the version can't be read as text", async () => {
    const store = workspaceWith({ id: "check.md", path: "check.md", label: "check.md", generated: "base", modified: "mine" });
    const attempt = () =>
      loadLatestIntoStaleBuffer({
        projectId: "space-a",
        path: "check.md",
        versioning: { mode: "stateless", originId: "gateway" },
        runtimeId: null,
        updateWorkspace: store.update,
      });
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValueOnce(null as never);
    expect(await attempt()).toBe(false);
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValueOnce({ ok: false, notFound: true } as never);
    expect(await attempt()).toBe(false);
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValueOnce(served("", { isText: false }) as never);
    expect(await attempt()).toBe(false);
    vi.mocked(controllerClient.workspace.files.readAt).mockRejectedValueOnce(new Error("offline"));
    expect(await attempt()).toBe(false);
    expect(store.update).not.toHaveBeenCalled();
    expect(store.current().files[0]?.modified).toBe("mine");
  });
});
