// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFile, CodeWorkspace } from "../../../../types";
import { createDefaultCodeWorkspace } from "../../../../code/defaults";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { useFilesPanelViewerState } from "../useFilesPanelViewerState";
import { clearRememberedBinaryPreviewRequests } from "../filesBinaryPreviewMemory";
import { readWorkspaceFileStaleNotice, writeWorkspaceFileStaleNotice } from "../workspaceFileStaleNoticeStore";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { files: { read: vi.fn(), readAt: vi.fn(), getRawUrl: vi.fn() } } },
}));

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);

type Options = Parameters<typeof useFilesPanelViewerState>[0];
const entry = (path: string, blobOid?: string): ControllerWorkspaceEntry => ({
  path,
  name: path.split("/").pop()!,
  kind: "file",
  ...(blobOid ? { blobOid } : {}),
});

function readOk(patch: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    file: {
      path: "README.md", isText: true, contentText: "server text", contentBase64: "", size: 11,
      encoding: "base64", mimeType: "text/plain", blobOid: BLOB_B, rev: REV_2, originId: "origin-1",
      originMode: "hosted", ...patch,
    },
  };
}

function cached(patch: Partial<CodeFile> = {}): CodeFile {
  return {
    id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "saved",
    blobOid: BLOB_A, baseRev: REV_1, originId: "origin-1", ...patch,
  };
}

describe("useFilesPanelViewerState in the versioned modes", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useFilesPanelViewerState>;
  let options: Options;
  let workspace: CodeWorkspace;
  const staleEvents: unknown[] = [];
  const onStale = (event: Event) => staleEvents.push((event as CustomEvent).detail);

  function Harness() {
    current = useFilesPanelViewerState(options);
    return null;
  }
  async function render(patch: Partial<Options> = {}) {
    options = { ...options, ...patch };
    await act(async () => root.render(<Harness />));
  }
  async function open(target: ControllerWorkspaceEntry, openOptions?: Parameters<typeof current.openTextFile>[1]) {
    await act(async () => current.openTextFile(target, openOptions));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    clearRememberedBinaryPreviewRequests();
    writeWorkspaceFileStaleNotice(null);
    staleEvents.length = 0;
    window.addEventListener("instafy:workspace-file-stale", onStale);
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValue(readOk());
    workspace = { ...createDefaultCodeWorkspace(), files: [] };
    options = {
      acceptExternalOpenEvents: false, activeFile: null, activeProjectId: "space-a", previewOwnerId: "viewer-a",
      effectiveRuntimeId: "runtime-a", workspaceOwnerKey: "origin-a", directoryEntriesRef: { current: {} },
      editorContainerRef: { current: null }, activeFilePathRef: { current: null }, lastExplorerSelectionRef: { current: null },
      getParentPath: (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      normalizePath: (path) => path, normalizedRootPath: "", isImageEntry: () => false,
      isLikelyTextEntry: () => true, isMarkdownWorkspacePath: () => false, isLargeScreen: true,
      workspaceFiles: [], loadDirectory: vi.fn(async () => []), openFileTab: vi.fn(), requestUrlPush: vi.fn(),
      setActiveFile: vi.fn(), setExpandedDirectories: vi.fn(), setMarkdownView: vi.fn(), setMobileView: vi.fn(),
      setRootPath: vi.fn(), setSearchTerm: vi.fn(), showStatus: vi.fn(), queueMarkdownHeadingJump: vi.fn(),
      updateWorkspace: vi.fn((updater) => { workspace = updater(workspace); }),
      versioning: { mode: "stateless", originId: "origin-1" },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.removeEventListener("instafy:workspace-file-stale", onStale);
    writeWorkspaceFileStaleNotice(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reads the pinned origin and keeps the read's rev, blob and origin on the buffer", async () => {
    await render();
    await open(entry("README.md", BLOB_B));
    expect(controllerClient.workspace.files.read).not.toHaveBeenCalled();
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", path: "README.md", routing: "default", originId: "origin-1",
    });
    expect(workspace.files[0]).toMatchObject({
      generated: "server text", modified: "server text", baseRev: REV_2, blobOid: BLOB_B, originId: "origin-1",
    });
    expect(workspace.files[0].readAt).toEqual(expect.any(Number));
  });

  it("reuses a clean buffer whose blob matches the listing", async () => {
    await render({ workspaceFiles: [cached()] });
    await open(entry("README.md", BLOB_A));
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    expect(current.viewerState.mode).toBe("text");
  });

  it("refetches a clean buffer whose blob differs or that has no rev", async () => {
    await render({ workspaceFiles: [cached()] });
    await open(entry("README.md", BLOB_B));
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledTimes(1);
    await render({ workspaceFiles: [cached({ baseRev: null })] });
    await open(entry("README.md", BLOB_A));
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledTimes(2);
  });

  it("keeps a dirty buffer with the same blob without a notice", async () => {
    await render({ workspaceFiles: [cached({ modified: "edited" })] });
    await open(entry("README.md", BLOB_A));
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    expect(staleEvents).toHaveLength(0);
  });

  it("keeps a dirty buffer and raises the stale notice when the blob differs", async () => {
    await render({ workspaceFiles: [cached({ modified: "edited" })] });
    await open(entry("README.md", BLOB_B));
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    expect(workspace.files).toHaveLength(0);
    expect(staleEvents).toEqual([
      expect.objectContaining({ path: "README.md", baseText: "saved", localText: "edited", originId: "origin-1" }),
    ]);
    expect(readWorkspaceFileStaleNotice()?.path).toBe("README.md");
  });

  it("raises the stale notice for a dirty buffer that was read without a rev", async () => {
    await render({ workspaceFiles: [cached({ modified: "edited", baseRev: null })] });
    await open(entry("README.md", BLOB_A));
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    expect(staleEvents).toHaveLength(1);
  });

  it("reads a clean buffer from another origin again from the origin read now", async () => {
    await render({
      versioning: { mode: "desktop", originId: "desktop-1" },
      workspaceFiles: [cached({ originId: "gateway-1" })],
    });
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValue(readOk({ originId: "desktop-1", rev: null }));
    await open(entry("README.md", BLOB_A));
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", path: "README.md", routing: "default", originId: "desktop-1",
    });
    expect(workspace.files[0]).toMatchObject({ originId: "desktop-1", baseRev: null, blobOid: BLOB_B });
  });

  it("checks a Desktop buffer by blob only", async () => {
    await render({
      versioning: { mode: "desktop", originId: "desk-1" },
      workspaceFiles: [cached({ baseRev: null, originId: "desk-1" })],
    });
    await open(entry("README.md", BLOB_A));
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    await render({ workspaceFiles: [cached({ baseRev: null, blobOid: null, originId: "desk-1", modified: "edited" })] });
    await open(entry("README.md", BLOB_A));
    expect(staleEvents).toHaveLength(1);
  });

  it("reads at a commit and retries unpinned once when the commit is unknown", async () => {
    vi.mocked(controllerClient.workspace.files.readAt)
      .mockResolvedValueOnce({
        ok: false, notFound: false, originId: "origin-1", originMode: "hosted",
        error: { status: 404, code: "rev_not_found", message: "rev not found", routeUnavailable: false },
      })
      .mockResolvedValueOnce(readOk());
    await render();
    await open(entry("README.md"), { forceFetch: true, rev: REV_2 });
    const calls = vi.mocked(controllerClient.workspace.files.readAt).mock.calls.map(([params]) => params);
    expect(calls).toEqual([
      { projectId: "space-a", path: "README.md", routing: "default", originId: "origin-1", rev: REV_2 },
      { projectId: "space-a", path: "README.md", routing: "default", originId: "origin-1" },
    ]);
    expect(workspace.files[0].baseRev).toBe(REV_2);
  });

  it("shows the size limit when a file is too large to open", async () => {
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValue({
      ok: false, notFound: false, originId: "origin-1", originMode: "hosted",
      error: { status: 413, code: "too_large", message: "too large", routeUnavailable: false },
    });
    await render();
    await open(entry("big.json"));
    expect(current.viewerState).toMatchObject({
      mode: "error", error: "This file is larger than 20 MB, so it can't be opened here.",
    });
  });

  it("keeps a preserved draft's read ids and reports a newer version", async () => {
    workspace = { ...workspace, files: [cached({ modified: "edited" })] };
    await render({ workspaceFiles: workspace.files });
    await open(entry("README.md"), { forceFetch: true, preserveDraft: true });
    expect(workspace.files[0]).toMatchObject({
      generated: "saved", modified: "edited", baseRev: REV_1, blobOid: BLOB_A, originId: "origin-1",
    });
    expect(staleEvents).toHaveLength(1);
  });

  it("never fetches a never-saved buffer when opening it or keeping its draft", async () => {
    await render({ workspaceFiles: [cached({ isNew: true, generated: "", modified: "", blobOid: null, baseRev: null })] });
    await open(entry("README.md"));
    await open(entry("README.md"), { forceFetch: true, preserveDraft: true });
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    expect(current.viewerState.mode).toBe("text");
    expect(options.setActiveFile).toHaveBeenCalledWith("README.md");
  });

  it("on Reload keeps a never-saved buffer that is still not in the space", async () => {
    vi.mocked(controllerClient.workspace.files.readAt).mockResolvedValue({
      ok: false, notFound: true, originId: "origin-1", originMode: "hosted",
      error: { status: 404, message: "not found", routeUnavailable: false },
    });
    workspace = { ...workspace, files: [cached({ isNew: true, generated: "", modified: "draft", blobOid: null, baseRev: null })] };
    await render({ workspaceFiles: workspace.files });
    await open(entry("README.md"), { forceFetch: true });
    expect(controllerClient.workspace.files.readAt).toHaveBeenCalledTimes(1);
    expect(current.viewerState.mode).toBe("text");
    expect(workspace.files[0]).toMatchObject({ isNew: true, modified: "draft" });
  });

  it("on Reload takes the space's version of a file that appeared there", async () => {
    workspace = { ...workspace, files: [cached({ isNew: true, generated: "", modified: "draft", blobOid: null, baseRev: null })] };
    await render({ workspaceFiles: workspace.files });
    await open(entry("README.md"), { forceFetch: true });
    expect(workspace.files[0]).toMatchObject({ generated: "server text", modified: "server text", baseRev: REV_2 });
    expect(workspace.files[0].isNew).toBeUndefined();
  });

  it("opens a just-created local buffer without fetching it", async () => {
    await render({ workspaceFiles: [] });
    await open(entry("new.md"), { localBuffer: true });
    expect(controllerClient.workspace.files.readAt).not.toHaveBeenCalled();
    expect(options.setActiveFile).toHaveBeenCalledWith("new.md");
    expect(current.viewerState.mode).toBe("text");
  });

  it("pins raw URLs to the default origin", async () => {
    vi.mocked(controllerClient.workspace.files.getRawUrl).mockResolvedValue("https://example.test/raw");
    await render();
    await act(async () => current.openImageFile(entry("photo.png")));
    expect(controllerClient.workspace.files.getRawUrl).toHaveBeenCalledWith({
      projectId: "space-a", path: "photo.png", routing: "default", originId: "origin-1",
    });
  });
});
