// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import type { CodeFile } from "../../../../types";
import { createOwnRevisions } from "../filesVersioning";
import { gitBlobOid } from "../../../../utils/gitBlobOid";
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
    // Listed once on mount, though the origin also reports ready then.
    expect(listCalls()).toEqual([{ projectId: "space-a", path: undefined, routing: "default", originId: "origin-1" }]);
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

  it("raises no notice for a dirty buffer without a blob id while the space holds its base text", async () => {
    // Hashing runs on real timers.
    vi.useRealTimers();
    const settle = () =>
      act(async () => {
        for (let tick = 0; tick < 10; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
    const dispatch = async (rev: string) => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "space-a", data: { rev } } }));
      });
      await settle();
    };
    const savedBlob = (await gitBlobOid("saved")) ?? undefined;
    expect(savedBlob).toBeDefined();
    listAt.mockImplementation(async () => listing([file("README.md", savedBlob)]));
    await render();
    await settle();
    options.dirtyFileIdsRef.current = new Set(["README.md"]);
    buffers["README.md"] = { id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "edited" };
    await dispatch(REV_2);
    expect(staleEvents).toHaveLength(0);
    listAt.mockImplementation(async () => listing([file("README.md", BLOB_B)]));
    await dispatch("4".repeat(40));
    expect(staleEvents).toEqual([expect.objectContaining({ path: "README.md" })]);
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

  it("lists expanded folders again at the root's rev after a legacy and stateless flip", async () => {
    await render();
    await act(async () => current.setExpandedDirectories(new Set(["src"])));
    await act(async () => { await current.loadDirectory("src"); });
    listAt.mockClear();

    await render({ versioning: { mode: "legacy", originId: null }, versionedOptions: null });
    await render({ versioning: { mode: "stateless", originId: "origin-1" }, versionedOptions: hooks });

    expect(listCalls()).toEqual([
      { projectId: "space-a", path: undefined, routing: "default", originId: "origin-1" },
      { projectId: "space-a", path: "src", routing: "default", originId: "origin-1", rev: REV_1 },
    ]);
    expect(current.directoryEntries.src).toEqual([file("src/a.ts", BLOB_A)]);
  });

  describe("an own commit", () => {
    const REV_3 = "3".repeat(40);
    const saveCheck = (parentRev: string) => act(async () => {
      hooks.ownRevisions.recordCommit({
        projectId: "space-a", originId: "origin-1", parentRev, rev: REV_3,
        writes: [{ path: "notes/check.md", blobOid: BLOB_A }], deletes: [],
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    async function expandNotes() {
      // A folder that is not in the space yet lists as empty (a 404) at the commit it was read from.
      listAt.mockImplementation(async ({ path }: { path?: string }) =>
        path === "notes" ? listing([], REV_1) : listing([folder("src")], REV_1));
      await render();
      await act(async () => current.setExpandedDirectories(new Set(["notes"])));
      await act(async () => { await current.loadDirectory("notes"); });
      expect(current.directoryRevsRef.current.notes).toBe(REV_1);
      listAt.mockImplementation(async ({ path }: { path?: string }) =>
        path === "notes" ? listing([file("notes/check.md", BLOB_A)], REV_3) : listing([folder("notes"), folder("src")], REV_3));
      listAt.mockClear();
    }

    it("is shown in place in the folders listed at its parent", async () => {
      await expandNotes();
      await saveCheck(REV_1);
      expect(listAt).not.toHaveBeenCalled();
      expect(current.directoryEntries.notes).toEqual([file("notes/check.md", BLOB_A)]);
      expect(current.directoryRevsRef.current.notes).toBe(REV_3);
    });

    it("lists a shown folder it wrote into again when its listing is at another commit", async () => {
      await expandNotes();
      await saveCheck(REV_2);
      // The root was listed at another commit too.
      expect(listCalls()).toHaveLength(2);
      expect(listCalls()).toEqual(expect.arrayContaining([
        { projectId: "space-a", path: undefined, routing: "default", originId: "origin-1", rev: REV_3 },
        { projectId: "space-a", path: "notes", routing: "default", originId: "origin-1", rev: REV_3 },
      ]));
      expect(current.directoryEntries.notes).toEqual([file("notes/check.md", BLOB_A)]);
      expect(current.directoryEntries[""]).toEqual([folder("notes"), folder("src")]);
    });

    it("lists in the current scope after a scope change that kept its subscription", async () => {
      await expandNotes();
      await render({ workspaceOwnerKey: "origin-b" });
      listAt.mockClear();
      await saveCheck(REV_2);
      expect(listCalls()).toContainEqual(
        { projectId: "space-a", path: "notes", routing: "default", originId: "origin-1", rev: REV_3 },
      );
    });

    it("forgets a closed folder it wrote into when its listing is at another commit", async () => {
      await expandNotes();
      await act(async () => current.setExpandedDirectories(new Set()));
      await saveCheck(REV_2);
      expect(listCalls().map((params) => params.path)).toEqual([undefined]);
      expect(current.directoryEntries.notes).toBeUndefined();
      expect(current.directoryRevsRef.current.notes).toBeUndefined();
    });

    it("made while the scope was legacy is listed once the scope is versioned again", async () => {
      await expandNotes();
      await render({ versioning: { mode: "legacy", originId: null }, versionedOptions: null });
      await saveCheck(REV_1);
      expect(listAt).not.toHaveBeenCalled();

      await render({ versioning: { mode: "stateless", originId: "origin-1" }, versionedOptions: hooks });

      expect(listCalls()).toContainEqual(
        { projectId: "space-a", path: "notes", routing: "default", originId: "origin-1", rev: REV_3 },
      );
      expect(current.directoryEntries.notes).toEqual([file("notes/check.md", BLOB_A)]);
    });
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
