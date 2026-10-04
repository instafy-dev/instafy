// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import type { CodeFile } from "../../../../types";
import { createOwnRevisions } from "../filesVersioning";
import { useFilesPanelWorkspaceTree, type FilesTreeVersionedOptions } from "../useFilesPanelWorkspaceTree";

const { list, listAt, saveChanges } = vi.hoisted(() => ({
  list: vi.fn(),
  listAt: vi.fn(),
  saveChanges: vi.fn(),
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    workspace: { files: { list, listAt }, save: { changes: saveChanges } },
  },
}));
vi.mock("../../../../components/Button", () => ({ Button: () => null }));
vi.mock("../../../../components/Spinner", () => ({ Spinner: () => null }));

const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);
const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);

const file = (path: string, blobOid?: string): ControllerWorkspaceEntry => ({
  path, name: path.split("/").pop()!, kind: "file", ...(blobOid ? { blobOid } : {}),
});
const folder = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "directory" });
const listing = (entries: ControllerWorkspaceEntry[], rev: string | null = REV_1) => ({
  ok: true as const, entries, rev, originId: "origin-1", originMode: "hosted",
});

describe("Files tree in the versioned modes", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useFilesPanelWorkspaceTree>;
  let options: Parameters<typeof useFilesPanelWorkspaceTree>[0];
  let hooks: FilesTreeVersionedOptions;
  let buffers: Record<string, CodeFile>;
  const staleEvents: unknown[] = [];
  const onStale = (event: Event) => staleEvents.push((event as CustomEvent).detail);
  const openTextFile = vi.fn(async () => undefined);

  function Harness() {
    current = useFilesPanelWorkspaceTree(options);
    return null;
  }
  async function render(patch: Partial<typeof options> = {}) {
    options = { ...options, ...patch };
    await act(async () => root.render(<Harness />));
  }
  async function commitEvent(rev: string | null) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", {
        detail: { projectId: "space-a", kind: "git.commit", data: rev ? { rev } : {} },
      }));
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  const listCalls = () => listAt.mock.calls.map(([params]) => params);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.useFakeTimers();
    staleEvents.length = 0;
    window.addEventListener("instafy:workspace-file-stale", onStale);
    buffers = {};
    listAt.mockImplementation(async ({ path }: { path?: string }) =>
      path === "src" ? listing([file("src/a.ts", BLOB_A)]) : listing([folder("src"), file("README.md", BLOB_A)]),
    );
    hooks = {
      ownRevisions: createOwnRevisions(),
      getBuffer: (path) => buffers[path] ?? null,
      discardBuffers: vi.fn(),
      writeReady: true,
      onWriteFailure: vi.fn(),
    };
    options = {
      activeFilePath: null, activeFileDraftRef: { current: { fileId: null, value: null } },
      activeFileGeneratedRef: { current: { fileId: null, value: null } }, activeFilePathRef: { current: null },
      activeProjectId: "space-a", dirtyFileIdsRef: { current: new Set() }, effectiveRuntimeId: "runtime",
      getActiveEditorValue: () => null, getParentPath: (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      isImageEntry: () => false, isLikelyTextEntry: () => true, isSafeWorkspaceRelativePath: () => true,
      lastLocalCommitRef: { current: null }, normalizedRootPath: "", normalizePath: (path) => path,
      runtimeReady: false, setActiveFile: vi.fn(), showStatus: vi.fn(), sortEntries: (entries) => entries,
      viewerActionsRef: { current: { openTextFile, openImageFile: vi.fn(), openUnsupportedFile: vi.fn() } },
      viewerStateRef: { current: { mode: "text", entry: file("README.md", BLOB_A), error: null } },
      setViewerStateRef: { current: vi.fn() }, waitingForPreferredRuntime: false, workspaceBrowseReady: true,
      workspaceOwnerId: "viewer-a", workspaceOwnerKey: "origin-a",
      versioning: { mode: "stateless", originId: "origin-1" },
      versionedOptions: hooks,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.removeEventListener("instafy:workspace-file-stale", onStale);
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("lists the pinned default origin and records the listing rev", async () => {
    await render();
    expect(list).not.toHaveBeenCalled();
    // Listed on mount and again once the origin reports ready, as in legacy mode.
    expect(new Set(listCalls().map((params) => JSON.stringify(params)))).toEqual(
      new Set([JSON.stringify({ projectId: "space-a", routing: "default", originId: "origin-1" })]),
    );
    expect(current.directoryRevsRef.current[""]).toBe(REV_1);
  });

  it("reloads every expanded listing at the event's commit without sync=blocking", async () => {
    await render();
    await act(async () => current.setExpandedDirectories(new Set(["src"])));
    listAt.mockClear();
    buffers["README.md"] = { id: "README.md", path: "README.md", label: "README.md", generated: "x", modified: "x", blobOid: BLOB_A, baseRev: REV_1 };
    await commitEvent(REV_2);
    expect(listCalls()).toEqual(expect.arrayContaining([
      { projectId: "space-a", path: undefined, routing: "default", originId: "origin-1", rev: REV_2 },
      { projectId: "space-a", path: "src", routing: "default", originId: "origin-1", rev: REV_2 },
    ]));
    expect(listCalls().every((params) => !("syncMode" in params))).toBe(true);
    // The open file's blob did not change: nothing is read again.
    expect(openTextFile).not.toHaveBeenCalled();
    expect(staleEvents).toHaveLength(0);
  });

  it("ignores the commit event of its own save for 60 seconds", async () => {
    await render();
    listAt.mockClear();
    hooks.ownRevisions.add(REV_2);
    await commitEvent(REV_2);
    expect(listAt).not.toHaveBeenCalled();
  });

  it("reads a changed clean file again at the commit and reports a changed dirty one", async () => {
    listAt.mockResolvedValue(listing([file("README.md", BLOB_B)], REV_2));
    buffers["README.md"] = { id: "README.md", path: "README.md", label: "README.md", generated: "x", modified: "x", blobOid: BLOB_A, baseRev: REV_1 };
    await render();
    await commitEvent(REV_2);
    expect(openTextFile).toHaveBeenCalledWith(file("README.md", BLOB_B), { forceFetch: true, rev: REV_2 });
    expect(staleEvents).toHaveLength(0);

    openTextFile.mockClear();
    options.dirtyFileIdsRef.current = new Set(["README.md"]);
    buffers["README.md"] = { ...buffers["README.md"], modified: "edited", originId: "origin-1" };
    await commitEvent("3".repeat(40));
    expect(openTextFile).not.toHaveBeenCalled();
    expect(staleEvents).toEqual([expect.objectContaining({ path: "README.md", originId: "origin-1" })]);
  });

  it("retries a listing unpinned when the origin does not know the commit", async () => {
    await render();
    listAt.mockReset();
    listAt
      .mockResolvedValueOnce({ ok: false, originId: "origin-1", originMode: "hosted", error: { status: 404, code: "rev_not_found", message: "", routeUnavailable: false } })
      .mockResolvedValue(listing([file("README.md", BLOB_A)], REV_1));
    await commitEvent(REV_2);
    expect(listCalls()).toEqual([
      { projectId: "space-a", path: undefined, routing: "default", originId: "origin-1", rev: REV_2 },
      { projectId: "space-a", path: undefined, routing: "default", originId: "origin-1" },
    ]);
    expect(current.directoryEntries[""]).toEqual([file("README.md", BLOB_A)]);
  });

  it("lists the root unpinned on a manual refresh and pins the other folders to its rev", async () => {
    await render();
    await act(async () => current.setExpandedDirectories(new Set(["src"])));
    listAt.mockClear();
    await act(async () => current.refreshFromWorkspaceCommit(null));
    expect(listCalls()).toEqual([
      { projectId: "space-a", path: undefined, routing: "default", originId: "origin-1" },
      { projectId: "space-a", path: "src", routing: "default", originId: "origin-1", rev: REV_1 },
    ]);
  });

  it("deletes a file with the parent listing's rev and the listed blob", async () => {
    saveChanges.mockResolvedValue({ ok: true, rev: REV_2, originId: "origin-1" });
    await render();
    await act(async () => current.handleDeleteExplorerEntry({ path: "README.md", kind: "file", name: "README.md" }, { confirmed: true }));
    expect(saveChanges).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", originId: "origin-1", deletes: ["README.md"], baseRev: REV_1, expected: { "README.md": BLOB_A },
    });
    expect(hooks.ownRevisions.has(REV_2)).toBe(true);
    expect(hooks.discardBuffers).toHaveBeenCalledWith("README.md");
  });

  it("deletes a Desktop folder without expected or baseRev", async () => {
    saveChanges.mockResolvedValue({ ok: true, rev: REV_2, originId: "desk-1" });
    await render({ versioning: { mode: "desktop", originId: "desk-1" } });
    await act(async () => current.handleDeleteExplorerEntry({ path: "src", kind: "directory", name: "src" }, { confirmed: true }));
    expect(saveChanges).toHaveBeenCalledExactlyOnceWith({ projectId: "space-a", originId: "desk-1", deletes: ["src"] });
  });

  it("drops a never-saved file locally and shows a failed delete with its copy", async () => {
    buffers["draft.md"] = { id: "draft.md", path: "draft.md", label: "draft.md", generated: "", modified: "", isNew: true };
    await render();
    await act(async () => current.handleDeleteExplorerEntry({ path: "draft.md", kind: "file", name: "draft.md" }, { confirmed: true }));
    expect(saveChanges).not.toHaveBeenCalled();
    expect(hooks.discardBuffers).toHaveBeenCalledWith("draft.md");

    saveChanges.mockResolvedValue({ ok: false, stage: "apply", error: { status: 409, code: "main_busy", message: "", routeUnavailable: false } });
    await act(async () => current.handleDeleteExplorerEntry({ path: "README.md", kind: "file", name: "README.md" }, { confirmed: true }));
    expect(hooks.onWriteFailure).toHaveBeenCalledWith(
      { message: "The space is busy saving other changes. Try again in a moment.", action: { kind: "retry", label: "Try again" } },
      expect.any(Function),
    );
  });

  it("does not delete without write access to the origin", async () => {
    hooks.writeReady = false;
    await render();
    await act(async () => current.handleDeleteExplorerEntry({ path: "README.md", kind: "file", name: "README.md" }, { confirmed: true }));
    expect(saveChanges).not.toHaveBeenCalled();
  });
});
