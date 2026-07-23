// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesPanelCreateEntries } from "../useFilesPanelCreateEntries";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: {
        write: mocks.write,
      },
    },
  },
}));

type HookValue = ReturnType<typeof useFilesPanelCreateEntries>;

describe("useFilesPanelCreateEntries read-only guard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HookValue | null;
  const loadDirectory = vi.fn();
  const openTextFile = vi.fn();

  function Harness({ readOnly }: { readOnly: boolean }) {
    latest = useFilesPanelCreateEntries({
      activeProjectId: "project-1",
      effectiveRuntimeId: "runtime-1",
      isLargeScreen: true,
      expandedDirectories: new Set(),
      emptyDirectoryPlaceholder: ".instafy.keep",
      normalizePath: (path) => path.replace(/^\/+|\/+$/g, ""),
      isSafeWorkspaceRelativePath: (path) => !path.split("/").includes(".."),
      getParentPath: (path) => path.split("/").slice(0, -1).join("/"),
      sortEntries: (entries) => entries,
      loadDirectory,
      showStatus: vi.fn(),
      ensureEntryVisible: vi.fn().mockResolvedValue(undefined),
      openTextFile,
      focusEditorWhenReady: vi.fn(),
      onLocalCommit: vi.fn(),
      setDirectoryEntries: vi.fn(),
      setExpandedDirectories: vi.fn(),
      setSearchTerm: vi.fn(),
      setMobileView: vi.fn(),
      clearExplorerMenu: vi.fn(),
      readOnly,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    mocks.write.mockReset();
    mocks.write.mockResolvedValue({ ok: true, size: 0, rev: "rev-1" });
    loadDirectory.mockReset();
    loadDirectory.mockResolvedValue([]);
    openTextFile.mockReset();
    openTextFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not even open a create draft for a viewer", async () => {
    await act(async () => root.render(<Harness readOnly />));
    await act(async () => {
      await latest?.handleStartCreateFile("");
      await latest?.handleCommitCreateFile();
      await latest?.handleStartCreateFolder("");
      await latest?.handleCommitCreateFolder();
    });

    expect(latest?.createFileState).toBeNull();
    expect(latest?.createFolderState).toBeNull();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("cancels an in-progress create draft when access becomes read-only", async () => {
    await act(async () => root.render(<Harness readOnly={false} />));
    await act(async () => {
      await latest?.handleStartCreateFile("");
    });
    expect(latest?.createFileState).not.toBeNull();

    await act(async () => root.render(<Harness readOnly />));

    expect(latest?.createFileState).toBeNull();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
