// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspace } from "../../../../types";
import { createDefaultCodeWorkspace } from "../../../../code/defaults";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { useFilesPanelViewerState, type OpenWorkspaceFileEventDetail } from "../useFilesPanelViewerState";
import { buildBinaryPreviewScopeKey, clearRememberedBinaryPreviewRequests, readBinaryPreviewRequest } from "../filesBinaryPreviewMemory";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { files: { read: vi.fn(), getRawUrl: vi.fn() } } },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const entry = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "file" });
const textResult = { path: "README.md", isText: true, contentText: "loaded file", contentBase64: "", size: 11, encoding: "utf8", mimeType: "text/plain" };
type Options = Parameters<typeof useFilesPanelViewerState>[0];
type FileWindow = Window & {
  __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: OpenWorkspaceFileEventDetail | null;
  __INSTAFY_OPEN_WORKSPACE_FILE_ACK__?: string | null;
};

describe("useFilesPanelViewerState request ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useFilesPanelViewerState>;
  let options: Options;
  let workspace: CodeWorkspace;
  let unmounted: boolean;
  const fileWindow = window as FileWindow;

  function Harness() {
    current = useFilesPanelViewerState(options);
    return <div data-mode={current.viewerState.mode}>{current.viewerState.entry?.path}</div>;
  }
  async function render(patch: Partial<Options> = {}, strict = false) {
    options = { ...options, ...patch };
    await act(async () => root.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />));
  }
  async function start(detail: OpenWorkspaceFileEventDetail) {
    let pending!: Promise<void>;
    await act(async () => { pending = current.openFileFromEvent(detail); });
    return { pending };
  }
  function dispatch(detail: OpenWorkspaceFileEventDetail) {
    window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    clearRememberedBinaryPreviewRequests();
    vi.mocked(controllerClient.workspace.files.read).mockResolvedValue(textResult);
    vi.mocked(controllerClient.workspace.files.getRawUrl).mockResolvedValue("https://example.test/authorized-preview");
    workspace = createDefaultCodeWorkspace();
    options = {
      acceptExternalOpenEvents: true, activeFile: null, activeProjectId: "space-a", previewOwnerId: "viewer-a",
      effectiveRuntimeId: "runtime-a", workspaceOwnerKey: "origin-a", directoryEntriesRef: { current: {} }, editorContainerRef: { current: null },
      activeFilePathRef: { current: null }, lastExplorerSelectionRef: { current: null },
      getParentPath: (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      normalizePath: (path) => path, normalizedRootPath: "", isImageEntry: (value) => value.path.endsWith(".png"),
      isLikelyTextEntry: (value) => /\.(md|ts)$/.test(value.path), isMarkdownWorkspacePath: (path) => Boolean(path?.endsWith(".md")),
      isLargeScreen: false, workspaceFiles: [], loadDirectory: vi.fn(async () => []),
      openFileTab: vi.fn(), requestUrlPush: vi.fn(), setActiveFile: vi.fn(), setExpandedDirectories: vi.fn(),
      setMarkdownView: vi.fn(), setMobileView: vi.fn(), setRootPath: vi.fn(), setSearchTerm: vi.fn(),
      showStatus: vi.fn(), queueMarkdownHeadingJump: vi.fn(), onOpenWorkspaceFileEvent: vi.fn(),
      updateWorkspace: vi.fn((updater) => { workspace = updater(workspace); }),
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    unmounted = false;
    delete fileWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
    delete fileWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__;
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    container.remove();
    clearRememberedBinaryPreviewRequests();
    delete fileWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
    delete fileWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens a legacy markdown request through directory lookup, workspace load, tab and preview", async () => {
    await render();
    const detail = { path: "README.md", projectId: "space-a", preferPreview: true, headingSlug: "setup", returnTarget: "assistant" as const };
    const { pending } = await start(detail);
    await act(async () => pending);
    expect(controllerClient.workspace.files.read).toHaveBeenCalledExactlyOnceWith({ projectId: "space-a", path: "README.md", runtimeId: "runtime-a" });
    expect(workspace.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(options.openFileTab).toHaveBeenCalledExactlyOnceWith({ id: "README.md", path: "README.md", label: "README.md" });
    expect(options.onOpenWorkspaceFileEvent).toHaveBeenCalledWith(detail);
    expect(options.setMarkdownView).toHaveBeenCalledWith("preview");
    expect(options.queueMarkdownHeadingJump).toHaveBeenCalledWith("setup");
    expect(current.viewerState.mode).toBe("text");
  });

  it.each(["parent", "root", "ancestor"])("stops before file I/O when cancelled during the %s directory read", async (stage) => {
    const directory = deferred<ControllerWorkspaceEntry[] | null>();
    const blockedPath = stage === "parent" ? "src/nested" : stage === "root" ? "" : "src";
    vi.mocked(options.loadDirectory).mockImplementation((path) => path === blockedPath ? directory.promise : Promise.resolve([]));
    const abort = new AbortController();
    await render({ normalizedRootPath: stage === "root" ? "other" : "" });
    const { pending } = await start({ path: "src/nested/main.ts", projectId: "space-a", signal: abort.signal });
    expect(options.loadDirectory).toHaveBeenCalledWith(blockedPath, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => { abort.abort(); directory.resolve([]); await pending; });
    expect(controllerClient.workspace.files.read).not.toHaveBeenCalled();
    expect(options.updateWorkspace).not.toHaveBeenCalled();
    expect(options.openFileTab).not.toHaveBeenCalled();
    expect(options.setExpandedDirectories).not.toHaveBeenCalled();
  });

  it("passes a live cancellation signal to directory work and stops text/markdown mutations after abort", async () => {
    const read = deferred<typeof textResult>();
    vi.mocked(controllerClient.workspace.files.read).mockReturnValue(read.promise);
    const abort = new AbortController();
    await render();
    const { pending } = await start({ path: "README.md", signal: abort.signal, preferPreview: true, headingSlug: "setup" });
    const directorySignal = vi.mocked(options.loadDirectory).mock.calls[0][1]?.signal;
    expect(directorySignal?.aborted).toBe(false);
    await act(async () => { abort.abort(); read.resolve(textResult); await pending; });
    expect(directorySignal?.aborted).toBe(true);
    expect(options.updateWorkspace).not.toHaveBeenCalled();
    expect(options.setActiveFile).not.toHaveBeenCalled();
    expect(options.openFileTab).not.toHaveBeenCalled();
    expect(options.setMarkdownView).not.toHaveBeenCalled();
    expect(options.queueMarkdownHeadingJump).not.toHaveBeenCalled();
  });

  it.each(["previewOwnerId", "activeProjectId", "effectiveRuntimeId", "workspaceOwnerKey"] as const)("rejects a late read across a %s A → B → A transition", async (key) => {
    const read = deferred<typeof textResult>();
    vi.mocked(controllerClient.workspace.files.read).mockReturnValue(read.promise);
    await render();
    const original = options[key];
    const staleOpen = current.openTextFile;
    const { pending } = await start({ path: "README.md" });
    await render({ [key]: "other" });
    await render({ [key]: original });
    await act(async () => { read.resolve(textResult); await pending; await staleOpen(entry("late.md")); });
    expect(options.updateWorkspace).not.toHaveBeenCalled();
    expect(options.openFileTab).not.toHaveBeenCalled();
    expect(controllerClient.workspace.files.read).toHaveBeenCalledTimes(1);
    expect(current.viewerState.mode).toBe("idle");
  });

  it("rejects deferred workspace updater work if the request is cancelled before reducer application", async () => {
    const updaters: Array<(value: CodeWorkspace) => CodeWorkspace> = [];
    const abort = new AbortController();
    await render({ updateWorkspace: vi.fn((updater) => { updaters.push(updater); }) });
    const { pending } = await start({ path: "README.md", signal: abort.signal });
    await act(async () => pending);
    abort.abort();
    expect(updaters).toHaveLength(1);
    expect(updaters[0](workspace)).toBe(workspace);
  });

  it("keeps the newer external selection when an older file read finishes later", async () => {
    const read = deferred<typeof textResult>();
    vi.mocked(controllerClient.workspace.files.read).mockImplementation((params) => params.path === "old.md" ? read.promise : Promise.resolve(textResult));
    await render();
    const old = await start({ path: "old.md" });
    const next = await start({ path: "new.md" });
    await act(async () => { await next.pending; read.resolve(textResult); await old.pending; });
    expect(workspace.files.map((file) => file.path)).toEqual(["new.md"]);
    expect(options.openFileTab).toHaveBeenCalledTimes(1);
    expect(current.viewerState.entry?.path).toBe("new.md");
  });

  it("lets direct explorer selection supersede a pending external read", async () => {
    const read = deferred<typeof textResult>();
    vi.mocked(controllerClient.workspace.files.read).mockReturnValue(read.promise);
    await render();
    const old = await start({ path: "README.md" });
    await act(async () => { await current.openImageFile(entry("photo.png")); read.resolve(textResult); await old.pending; });
    expect(options.openFileTab).not.toHaveBeenCalled();
    expect(options.updateWorkspace).not.toHaveBeenCalled();
    expect(current.viewerState.mode).toBe("image");
    expect(readBinaryPreviewRequest(buildBinaryPreviewScopeKey("viewer-a", "space-a"))?.entry.path).toBe("photo.png");
  });

  it.each(["image", "unsupported", "binary-text"])("discards a cancelled %s raw URL without caching or showing it", async (kind) => {
    const raw = deferred<string | null>();
    vi.mocked(controllerClient.workspace.files.getRawUrl).mockReturnValue(raw.promise);
    if (kind === "binary-text") vi.mocked(controllerClient.workspace.files.read).mockResolvedValue({ ...textResult, isText: false });
    const abort = new AbortController();
    await render();
    const path = kind === "image" ? "photo.png" : kind === "unsupported" ? "archive.zip" : "README.md";
    const { pending } = await start({ path, signal: abort.signal });
    expect(controllerClient.workspace.files.getRawUrl).toHaveBeenCalledTimes(1);
    const mobileCalls = vi.mocked(options.setMobileView).mock.calls.length;
    await act(async () => { abort.abort(); raw.resolve("https://example.test/stale"); await pending; });
    expect(current.viewerState.imageUrl ?? current.viewerState.rawUrl).toBeUndefined();
    expect(readBinaryPreviewRequest(buildBinaryPreviewScopeKey("viewer-a", "space-a"))).toBeNull();
    expect(options.setMobileView).toHaveBeenCalledTimes(mobileCalls);
    expect(options.showStatus).not.toHaveBeenCalled();
  });

  it("discards late work and suppresses stale errors after unmount", async () => {
    const raw = deferred<string | null>();
    vi.mocked(controllerClient.workspace.files.getRawUrl).mockReturnValue(raw.promise);
    await render();
    const { pending } = await start({ path: "photo.png" });
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => { raw.reject(new Error("late failure")); await pending; });
    expect(options.showStatus).not.toHaveBeenCalled();
    expect(options.updateWorkspace).not.toHaveBeenCalled();
    expect(readBinaryPreviewRequest(buildBinaryPreviewScopeKey("viewer-a", "space-a"))).toBeNull();
  });

  it("acknowledges pending handoffs once an eligible listener accepts them, without restarting reads on rerender/retry", async () => {
    const read = deferred<typeof textResult>();
    vi.mocked(controllerClient.workspace.files.read).mockReturnValue(read.promise);
    const abort = new AbortController();
    const detail = { path: "README.md", projectId: "space-a", handoffId: "search-open", signal: abort.signal };
    fileWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
    await render({ acceptExternalOpenEvents: false });
    expect(fileWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__).toBeUndefined();
    await render({ acceptExternalOpenEvents: true });
    expect(fileWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__).toBe("search-open");
    expect(fileWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toBeNull();
    await render({ workspaceFiles: [] });
    await act(async () => { dispatch(detail); dispatch(detail); });
    expect(controllerClient.workspace.files.read).toHaveBeenCalledTimes(1);
    await act(async () => { abort.abort(); read.resolve(textResult); });
    expect(options.openFileTab).not.toHaveBeenCalled();
  });

  it("preserves edits made while a conversation file view is reopening", async () => {
    await render();
    await act(async () => current.openTextFile(entry("README.md")));
    const read = deferred<typeof textResult>();
    vi.mocked(controllerClient.workspace.files.read).mockReturnValue(read.promise);
    const { pending } = await start({ path: "README.md", preserveDraft: true });
    workspace = { ...workspace, files: workspace.files.map(file => ({ ...file, modified: "unsaved notes" })) };
    await act(async () => { read.resolve({ ...textResult, contentText: "new disk content" }); await pending; });
    expect(workspace.files[0].modified).toBe("unsaved notes");
    expect(workspace.files[0].generated).toBe("loaded file");
    expect(current.viewerState.mode).toBe("text");
  });

  it("ignores wrong-project and already-aborted handoffs", async () => {
    const abort = new AbortController();
    abort.abort();
    await render();
    await act(async () => {
      dispatch({ path: "README.md", projectId: "space-b", handoffId: "wrong-space" });
      dispatch({ path: "README.md", signal: abort.signal, handoffId: "cancelled" });
    });
    expect(options.loadDirectory).not.toHaveBeenCalled();
    expect(fileWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__).toBeUndefined();
  });

  it("preserves a pre-mount handoff through StrictMode effect replay", async () => {
    fileWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = { path: "README.md", projectId: "space-a", handoffId: "strict-open" };
    await render({}, true);
    expect(fileWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__).toBe("strict-open");
    expect(controllerClient.workspace.files.read).toHaveBeenCalledTimes(1);
    expect(options.openFileTab).toHaveBeenCalledTimes(1);
  });

  it("cancels folder focusing before a late directory response changes the selected root", async () => {
    const directory = deferred<ControllerWorkspaceEntry[] | null>();
    const abort = new AbortController();
    vi.mocked(options.loadDirectory).mockImplementation((path) => path === "docs" ? directory.promise : Promise.resolve([]));
    await render({ directoryEntriesRef: { current: { "": [{ name: "docs", path: "docs", kind: "directory" }] } } });
    const { pending } = await start({ path: "docs", signal: abort.signal });
    await act(async () => { abort.abort(); directory.resolve([]); await pending; });
    expect(options.setRootPath).not.toHaveBeenCalled();
    expect(options.setSearchTerm).not.toHaveBeenCalled();
    expect(options.setMobileView).not.toHaveBeenCalled();
    expect(controllerClient.workspace.files.read).not.toHaveBeenCalled();
  });

  it("preserves an existing local draft when reopening a loaded file from the explorer", async () => {
    const file = { id: "README.md", path: "README.md", label: "README.md", kind: "file" as const,
      directory: null, generated: "original", modified: "local draft", mimeType: "text/plain", size: 8, modifiedAt: null };
    workspace = { ...workspace, files: [file] };
    await render({ workspaceFiles: [file] });
    await act(async () => current.openTextFile(entry("README.md")));
    expect(controllerClient.workspace.files.read).not.toHaveBeenCalled();
    expect(workspace.files[0].modified).toBe("local draft");
    expect(options.openFileTab).toHaveBeenCalledTimes(1);
  });

  it("restores remembered media with a fresh authorized URL after remount", async () => {
    await render();
    await act(async () => current.openImageFile(entry("photo.png")));
    vi.mocked(controllerClient.workspace.files.getRawUrl).mockResolvedValue("https://example.test/fresh-preview");
    await act(async () => root.render(<Harness key="new-viewer" />));
    expect(controllerClient.workspace.files.getRawUrl).toHaveBeenCalledTimes(2);
    expect(current.viewerState).toMatchObject({ mode: "image", imageUrl: "https://example.test/fresh-preview" });
  });
});
