// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { useFilesPanelWorkspaceTree } from "../useFilesPanelWorkspaceTree";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { core: { enabled: true }, workspace: { files: { list } } } }));
vi.mock("../../../../components/Button", () => ({ Button: () => null }));
vi.mock("../../../../components/Spinner", () => ({ Spinner: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const file = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "file" });

describe("Explorer metadata publication ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useFilesPanelWorkspaceTree>;
  let options: Parameters<typeof useFilesPanelWorkspaceTree>[0];
  function Harness() { current = useFilesPanelWorkspaceTree(options); return null; }
  async function render(patch: Partial<typeof options> = {}) {
    options = { ...options, ...patch };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    list.mockResolvedValue([]);
    options = {
      activeFilePath: null, activeFileDraftRef: { current: { fileId: null, value: null } },
      activeFileGeneratedRef: { current: { fileId: null, value: null } }, activeFilePathRef: { current: null },
      activeProjectId: "space-a", dirtyFileIdsRef: { current: new Set() }, effectiveRuntimeId: "runtime",
      getActiveEditorValue: () => null, getParentPath: (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      isImageEntry: () => false, isLikelyTextEntry: () => true, isSafeWorkspaceRelativePath: () => true,
      lastLocalCommitRef: { current: null }, normalizedRootPath: "", normalizePath: (path) => path,
      runtimeReady: false, setActiveFile: vi.fn(), showStatus: vi.fn(), sortEntries: (entries) => entries,
      viewerActionsRef: { current: null }, viewerStateRef: { current: { mode: "idle", entry: null, error: null } },
      setViewerStateRef: { current: vi.fn() }, waitingForPreferredRuntime: false, workspaceBrowseReady: false,
      workspaceOwnerId: "viewer-a", workspaceOwnerKey: "origin-a", onDirectoryEntriesLoaded: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("publishes an unopened visible file from the existing listing and makes no extra read", async () => {
    list.mockResolvedValue([file("INSTAFY.md"), file(".instafy.keep")]);
    await render();
    expect(list).toHaveBeenCalledTimes(1);
    expect(options.onDirectoryEntriesLoaded).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", directory: "", entries: [file("INSTAFY.md")],
    });
    await act(async () => { await current.loadDirectory(""); });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each(["activeProjectId", "workspaceOwnerId", "workspaceOwnerKey", "effectiveRuntimeId"] as const)("rejects delayed owner A → B → A listings when %s changes", async (key) => {
    const old = deferred<ControllerWorkspaceEntry[]>();
    list.mockReturnValueOnce(old.promise);
    await render();
    const original = options[key];
    await render({ [key]: "other-owner" });
    await render({ [key]: original });
    vi.mocked(options.onDirectoryEntriesLoaded!).mockClear();
    await act(async () => old.resolve([file("stale.md")]));
    expect(options.onDirectoryEntriesLoaded).not.toHaveBeenCalled();
    expect(current.directoryEntries[""]).toEqual([]);
  });

  it("ignores late listings after unmount and ignores superseded requests within one directory", async () => {
    const old = deferred<ControllerWorkspaceEntry[]>();
    list.mockReturnValueOnce(old.promise);
    await render();
    list.mockResolvedValueOnce([file("fresh.md")]);
    await act(async () => { await current.loadDirectory("", { force: true }); });
    await act(async () => old.resolve([file("stale.md")]));
    expect(current.directoryEntries[""]).toEqual([file("fresh.md")]);
    const pending = deferred<ControllerWorkspaceEntry[]>();
    list.mockReturnValueOnce(pending.promise);
    let request!: Promise<ControllerWorkspaceEntry[] | null>;
    await act(async () => { request = current.loadDirectory("src", { force: true }); });
    await act(async () => root.render(null));
    vi.mocked(options.onDirectoryEntriesLoaded!).mockClear();
    await act(async () => { pending.resolve([file("src/stale.ts")]); await request; });
    expect(options.onDirectoryEntriesLoaded).not.toHaveBeenCalled();
  });

  it("cancels an unopened file's parent listing without poisoning the next folder load", async () => {
    await render();
    const aborted = new AbortController();
    aborted.abort();
    await act(async () => { expect(await current.loadDirectory("src", { force: true, signal: aborted.signal })).toBeNull(); });
    expect(list).toHaveBeenCalledTimes(1);
    const pending = deferred<ControllerWorkspaceEntry[]>();
    const abort = new AbortController();
    list.mockReturnValueOnce(pending.promise);
    let request!: Promise<ControllerWorkspaceEntry[] | null>;
    await act(async () => { request = current.loadDirectory("src", { force: true, signal: abort.signal }); });
    await act(async () => abort.abort());
    expect(current.directoryStatus.src).toBe("idle");
    vi.mocked(options.onDirectoryEntriesLoaded!).mockClear();
    await act(async () => { pending.resolve([file("src/stale.ts")]); expect(await request).toBeNull(); });
    expect(options.onDirectoryEntriesLoaded).not.toHaveBeenCalled();
    list.mockImplementation(async ({ path }) => path === "src" ? [file("src/fresh.ts")] : []);
    await render({ workspaceBrowseReady: true });
    await act(async () => { await current.loadDirectory("src"); });
    expect(current.directoryEntries.src).toEqual([file("src/fresh.ts")]);
  });

  it("does not retry a cancelled or abandoned directory failure", async () => {
    vi.useFakeTimers();
    await render();
    const abort = new AbortController();
    list.mockResolvedValueOnce(null);
    await act(async () => { await current.loadDirectory("src", { force: true, signal: abort.signal }); });
    await act(async () => abort.abort());
    const reads = list.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(2000));
    expect(list).toHaveBeenCalledTimes(reads);
  });

  it("keeps a safe root listing valid when revealing a file outside the focused directory", async () => {
    await render({ normalizedRootPath: "src" });
    const pending = deferred<ControllerWorkspaceEntry[]>();
    list.mockReturnValueOnce(pending.promise);
    let request!: Promise<ControllerWorkspaceEntry[] | null>;
    await act(async () => { request = current.loadDirectory("", { force: true }); });
    // Revealing the root starts another normal listing; its cached result may finish first.
    await render({ normalizedRootPath: "" });
    await act(async () => { pending.resolve([file("INSTAFY.md")]); expect(await request).toEqual([file("INSTAFY.md")]); });
    expect(options.onDirectoryEntriesLoaded).not.toHaveBeenCalledWith(expect.objectContaining({ entries: [file("INSTAFY.md")] }));
    // A new request using the original safe load function can still load the revealed folder.
    list.mockResolvedValueOnce([file("INSTAFY.md")]);
    await act(async () => { expect(await current.loadDirectory("", { force: true })).toEqual([file("INSTAFY.md")]); });
  });
});
