// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { createOwnRevisions } from "../filesVersioning";
import { useFilesPanelCreateEntries, type FilesCreateVersionedOptions } from "../useFilesPanelCreateEntries";
import type { FilesVersioning } from "../filesVersioning";

const mocks = vi.hoisted(() => ({ write: vi.fn(), saveChanges: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { files: { write: mocks.write }, save: { changes: mocks.saveChanges } } },
}));

const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);
type HookValue = ReturnType<typeof useFilesPanelCreateEntries>;

describe("useFilesPanelCreateEntries in the versioned modes", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HookValue | null;
  let hooks: FilesCreateVersionedOptions;
  let versioning: FilesVersioning;
  const loadDirectory = vi.fn();
  const openTextFile = vi.fn();
  const ensureEntryVisible = vi.fn();
  const showStatus = vi.fn();
  const setDirectoryEntries = vi.fn();

  function Harness() {
    latest = useFilesPanelCreateEntries({
      activeProjectId: "project-1", effectiveRuntimeId: "runtime-1", isLargeScreen: true,
      expandedDirectories: new Set(), emptyDirectoryPlaceholder: ".instafy.keep",
      normalizePath: (path) => path.replace(/^\/+|\/+$/g, ""),
      isSafeWorkspaceRelativePath: (path) => !path.split("/").includes(".."),
      getParentPath: (path) => path.split("/").slice(0, -1).join("/"),
      sortEntries: (entries) => entries, loadDirectory, showStatus, ensureEntryVisible, openTextFile,
      focusEditorWhenReady: vi.fn(), onLocalCommit: vi.fn(), setDirectoryEntries,
      setExpandedDirectories: vi.fn(), setSearchTerm: vi.fn(), setMobileView: vi.fn(), clearExplorerMenu: vi.fn(),
      versioning, versionedOptions: hooks,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    vi.clearAllMocks();
    loadDirectory.mockResolvedValue([]);
    openTextFile.mockResolvedValue(undefined);
    ensureEntryVisible.mockResolvedValue(true);
    versioning = { mode: "stateless", originId: "origin-1" };
    const listed: Record<string, ControllerWorkspaceEntry[]> = {
      "": [{ name: "README.md", path: "README.md", kind: "file" }],
    };
    hooks = {
      ownRevisions: createOwnRevisions(),
      directoryRevsRef: { current: { "": REV_1 } },
      directoryEntriesRef: { current: listed },
      keepFoldersRef: { current: new Set() },
      hasBuffer: vi.fn(() => false),
      createBuffer: vi.fn(),
      onWriteFailure: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("creates a new file as a local buffer without any request", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => latest?.setCreateFileState({ parentPath: "", draft: "notes.md", busy: false }));
    await act(async () => latest?.handleCommitCreateFile());
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.saveChanges).not.toHaveBeenCalled();
    expect(loadDirectory).not.toHaveBeenCalled();
    expect(hooks.createBuffer).toHaveBeenCalledExactlyOnceWith("notes.md");
    expect(openTextFile).toHaveBeenCalledExactlyOnceWith(
      { name: "notes.md", path: "notes.md", kind: "file" },
      { localBuffer: true },
    );
    expect(latest?.createFileState).toBeNull();
  });

  it("refuses a name that is already listed or buffered", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => latest?.setCreateFileState({ parentPath: "", draft: "README.md", busy: false }));
    await act(async () => latest?.handleCommitCreateFile());
    expect(hooks.createBuffer).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("A file with that name already exists.", "warning", 3500);
  });

  it("creates a folder as one placeholder commit on the parent listing's rev", async () => {
    mocks.saveChanges.mockResolvedValue({ ok: true, rev: REV_2, baseRev: REV_1, originId: "origin-1" });
    const commits: unknown[] = [];
    hooks.ownRevisions.subscribe((commit) => commits.push(commit));
    await act(async () => root.render(<Harness />));
    await act(async () => latest?.setCreateFolderState({ parentPath: "", draft: "docs", busy: false }));
    await act(async () => latest?.handleCommitCreateFolder());
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1",
      originId: "origin-1",
      files: [{ path: "docs/.instafy.keep", content: "", encoding: "utf8" }],
      expected: { "docs/.instafy.keep": null },
      baseRev: REV_1,
    });
    expect(hooks.ownRevisions.has(REV_2)).toBe(true);
    // Every Files panel shows the folder and moves its listings to the
    // folder's own commit.
    expect(commits).toEqual([{
      projectId: "project-1",
      originId: "origin-1",
      parentRev: REV_1,
      rev: REV_2,
      writes: [{ path: "docs/.instafy.keep", blobOid: null }],
      deletes: [],
    }]);
    expect(hooks.keepFoldersRef.current.has("docs")).toBe(true);
    expect(latest?.createFolderState).toBeNull();
  });

  it("sends no baseRev for a Desktop folder and reports failures with their copy", async () => {
    versioning = { mode: "desktop", originId: "desk-1" };
    hooks.directoryRevsRef.current = {};
    mocks.saveChanges.mockResolvedValue({
      ok: false, stage: "token", error: { status: 0, code: "token_unavailable", message: "", routeUnavailable: false },
    });
    await act(async () => root.render(<Harness />));
    await act(async () => latest?.setCreateFolderState({ parentPath: "", draft: "docs", busy: false }));
    await act(async () => latest?.handleCommitCreateFolder());
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1",
      originId: "desk-1",
      files: [{ path: "docs/.instafy.keep", content: "", encoding: "utf8" }],
      expected: { "docs/.instafy.keep": null },
    });
    expect(hooks.onWriteFailure).toHaveBeenCalledWith(
      { message: "The folder on this computer isn't connected." },
      expect.any(Function),
    );
    expect(latest?.createFolderState?.busy).toBe(false);
  });
});
