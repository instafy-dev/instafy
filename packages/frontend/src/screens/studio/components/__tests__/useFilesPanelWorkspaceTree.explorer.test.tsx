// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { useFilesPanelWorkspaceTree } from "../useFilesPanelWorkspaceTree";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { core: { enabled: true }, workspace: { files: { list } } } }));
vi.mock("../../../../components/Button", () => ({
  Button: ({ children, onPress, "aria-label": label }: { children: ReactNode; onPress?: () => void; "aria-label"?: string }) => (
    <button type="button" aria-label={label} onClick={onPress}>{children}</button>
  ),
}));
vi.mock("../../../../components/Spinner", () => ({ Spinner: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const file = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "file" });
const folder = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "directory" });

describe("Files explorer folders and loading copy", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useFilesPanelWorkspaceTree>;
  let options: Parameters<typeof useFilesPanelWorkspaceTree>[0];
  let statusPath = "";
  function Harness() {
    current = useFilesPanelWorkspaceTree(options);
    return <output>{current.renderDirectoryStatus(statusPath)}</output>;
  }
  async function render(patch: Partial<typeof options> = {}) {
    options = { ...options, ...patch };
    await act(async () => root.render(<Harness />));
  }
  const statusText = () => container.querySelector("output")?.textContent ?? "";
  const retryButton = () => container.querySelector<HTMLButtonElement>("output button");
  // Every listing retry, 500 ms up to 16 s apart, until the folder gives up.
  const runOutRetries = () => act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  // Folder listings only: the root is listed on mount and again once the workspace is ready.
  const listedFolders = () => list.mock.calls.map(([params]) => params.path ?? "").filter(Boolean);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.useFakeTimers();
    statusPath = "";
    list.mockResolvedValue([]);
    options = {
      activeFilePath: null, activeFileDraftRef: { current: { fileId: null, value: null } },
      activeFileGeneratedRef: { current: { fileId: null, value: null } }, activeFilePathRef: { current: null },
      activeProjectId: "space-a", dirtyFileIdsRef: { current: new Set() }, effectiveRuntimeId: "runtime",
      getActiveEditorValue: () => null, getParentPath: (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      isImageEntry: () => false, isLikelyTextEntry: () => true, isSafeWorkspaceRelativePath: () => true,
      lastLocalCommitRef: { current: null }, normalizedRootPath: "", normalizePath: (path) => path,
      runtimeReady: true, setActiveFile: vi.fn(), showStatus: vi.fn(), sortEntries: (entries) => entries,
      viewerActionsRef: { current: null }, viewerStateRef: { current: { mode: "idle", entry: null, error: null } },
      setViewerStateRef: { current: vi.fn() }, waitingForPreferredRuntime: false, workspaceBrowseReady: true,
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

  describe("loading copy", () => {
    it("says it is opening files while the workspace connects", async () => {
      list.mockReturnValue(new Promise(() => undefined));
      await render({ runtimeReady: false, workspaceBrowseReady: false });
      expect(statusText()).toBe("Opening files…");
      expect(current.getDirectoryLoadingLabel("")).toBe("Opening files…");
    });

    it("says it is reconnecting when files are already on screen", async () => {
      list.mockResolvedValue([file("notes.md")]);
      await render({ runtimeReady: false, workspaceBrowseReady: false });
      expect(current.directoryEntries[""]).toEqual([file("notes.md")]);
      expect(statusText()).toBe("Reconnecting to your files…");
    });

    it("says it is still opening files while a failed listing retries", async () => {
      list.mockResolvedValue(null);
      await render();
      expect(current.directoryStatus[""]).toBe("loading");
      expect(statusText()).toBe("Still opening files…");
      expect(current.getDirectoryLoadingLabel("")).toBe("Still opening files…");
    });

    it("says it is waiting for the chosen machine", async () => {
      list.mockReturnValue(new Promise(() => undefined));
      await render({ runtimeReady: false, workspaceBrowseReady: false, waitingForPreferredRuntime: true });
      expect(statusText()).toBe("Waiting for your chosen machine…");
    });

    it("keeps the first load plain", async () => {
      list.mockReturnValue(new Promise(() => undefined));
      await render();
      expect(statusText()).toBe("Loading files…");
    });
  });

  describe("pressing a folder row", () => {
    it("expands the folder at once and shows its listing loading", async () => {
      const pending = deferred<ControllerWorkspaceEntry[]>();
      list.mockImplementation(({ path }) => path === "skills" ? pending.promise : Promise.resolve([folder("skills")]));
      await render();
      statusPath = "skills";

      await act(async () => current.toggleDirectory(folder("skills")));

      expect(current.expandedDirectories.has("skills")).toBe(true);
      expect(listedFolders()).toEqual(["skills"]);
      expect(statusText()).toBe("Loading files…");
      expect(options.setActiveFile).toHaveBeenCalledWith(null);
      const viewerUpdate = vi.mocked(options.setViewerStateRef.current!).mock.calls.at(-1)?.[0];
      expect(typeof viewerUpdate === "function" && viewerUpdate({ mode: "idle", entry: null, error: null }))
        .toEqual({ mode: "directory", entry: folder("skills"), error: null });

      await act(async () => pending.resolve([file("skills/write.md")]));
      expect(current.directoryEntries.skills).toEqual([file("skills/write.md")]);
      expect(statusText()).toBe("");
    });

    it("lists a never-opened folder even before the workspace reports ready", async () => {
      list.mockImplementation(async ({ path }) => path === ".agents" ? [folder(".agents/skills")] : [folder(".agents")]);
      await render({ runtimeReady: false, workspaceBrowseReady: false });

      await act(async () => current.toggleDirectory(folder(".agents")));

      expect(current.expandedDirectories.has(".agents")).toBe(true);
      expect(listedFolders()).toEqual([".agents"]);
      expect(current.directoryEntries[".agents"]).toEqual([folder(".agents/skills")]);
    });

    it("collapses an open folder without listing it again", async () => {
      list.mockImplementation(async ({ path }) => path === "skills" ? [file("skills/write.md")] : [folder("skills")]);
      await render();
      await act(async () => current.toggleDirectory(folder("skills")));
      expect(current.expandedDirectories.has("skills")).toBe(true);

      await act(async () => current.toggleDirectory(folder("skills")));
      expect(current.expandedDirectories.has("skills")).toBe(false);
      await act(async () => current.toggleDirectory(folder("skills")));
      expect(current.expandedDirectories.has("skills")).toBe(true);
      expect(listedFolders()).toEqual(["skills"]);
    });

    it("says a folder could not be opened, with a Retry named for it, even before the workspace is ready", async () => {
      list.mockImplementation(async ({ path }) => path === "skills" ? null : [folder("skills")]);
      await render({ runtimeReady: false, workspaceBrowseReady: false });
      statusPath = "skills";

      await act(async () => current.toggleDirectory(folder("skills")));
      expect(statusText()).toBe("Opening files…");
      await runOutRetries();

      expect(current.directoryStatus.skills).toBe("error");
      expect(statusText()).toBe("Couldn't open this folder.Retry");
      expect(retryButton()?.getAttribute("aria-label")).toBe("Retry opening skills");

      list.mockResolvedValue([file("skills/write.md")]);
      await act(async () => retryButton()?.click());
      expect(current.directoryEntries.skills).toEqual([file("skills/write.md")]);
      expect(statusText()).toBe("");
    });

    it("names the folder in each Retry, so failed folders can be told apart", async () => {
      list.mockImplementation(async ({ path }) => path ? null : [folder("docs")]);
      await render();
      await act(async () => current.toggleDirectory(folder("docs")));
      await act(async () => current.toggleDirectory(folder("docs/guides")));
      await runOutRetries();
      statusPath = "docs";
      await render();
      expect(retryButton()?.getAttribute("aria-label")).toBe("Retry opening docs");
      statusPath = "docs/guides";
      await render();
      expect(retryButton()?.getAttribute("aria-label")).toBe("Retry opening guides");
    });

    it("says the files could not be opened when the root listing gives up while the workspace connects", async () => {
      list.mockResolvedValue(null);
      await render({ runtimeReady: false, workspaceBrowseReady: false });
      await runOutRetries();
      expect(current.directoryStatus[""]).toBe("error");
      expect(statusText()).toBe("Couldn't open your files.Retry");
      expect(retryButton()?.getAttribute("aria-label")).toBe("Retry opening your files");
    });

    it("shows no loading line under a folder nothing is listing", async () => {
      await render({ runtimeReady: false, workspaceBrowseReady: false });
      statusPath = "skills";
      await render();
      expect(current.directoryStatus.skills).toBeUndefined();
      expect(statusText()).toBe("");
    });

    it("leaves files to the viewer", async () => {
      await render();
      await act(async () => current.toggleDirectory(file("notes.md")));
      expect(current.expandedDirectories.size).toBe(0);
      expect(options.setActiveFile).not.toHaveBeenCalled();
    });
  });

  describe("an expanded folder", () => {
    const listSkills = async () => {
      list.mockImplementation(async ({ path }) => path === "skills" ? [file("skills/write.md")] : [folder("skills")]);
      await render();
      await act(async () => current.toggleDirectory(folder("skills")));
      expect(current.directoryEntries.skills).toEqual([file("skills/write.md")]);
    };

    it("is listed again after the listing scope changes", async () => {
      let pending = deferred<ControllerWorkspaceEntry[]>();
      list.mockImplementation(({ path }) => path === "skills" ? pending.promise : Promise.resolve([folder("skills")]));
      await render();
      await act(async () => current.toggleDirectory(folder("skills")));
      await act(async () => pending.resolve([file("skills/write.md")]));
      list.mockClear();
      pending = deferred();
      statusPath = "skills";

      await render({ workspaceOwnerKey: "origin-b" });

      expect(listedFolders()).toEqual(["skills"]);
      // Only the root listing waits on a runtime sync.
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ path: "skills", syncMode: "background" }));
      expect(statusText()).toBe("Loading files…");
      await act(async () => pending.resolve([file("skills/write.md")]));
      expect(current.directoryEntries.skills).toEqual([file("skills/write.md")]);
      expect(current.expandedDirectories.has("skills")).toBe(true);
      expect(statusText()).toBe("");
    });

    it("is closed, and never listed, when another space opens", async () => {
      await listSkills();
      list.mockClear();

      await render({ activeProjectId: "space-b" });

      expect(list.mock.calls.map(([params]) => [params.projectId, params.path ?? ""])).toEqual([["space-b", ""]]);
      expect(current.expandedDirectories.size).toBe(0);
    });

    it("waits while the workspace is not browse-ready and is listed once when it is again", async () => {
      await listSkills();
      list.mockClear();

      // Unreachable: only the root is listed, as before; the folder keeps its
      // listing instead of retrying against a workspace that can't answer.
      await render({ workspaceBrowseReady: false });
      expect(listedFolders()).toEqual([]);
      expect(list).toHaveBeenCalledOnce();
      expect(current.directoryEntries.skills).toEqual([file("skills/write.md")]);
      list.mockClear();

      await render({ workspaceBrowseReady: true });

      expect(listedFolders()).toEqual(["skills"]);
      expect(list.mock.calls.filter(([params]) => !params.path)).toHaveLength(1);
    });
  });
});
