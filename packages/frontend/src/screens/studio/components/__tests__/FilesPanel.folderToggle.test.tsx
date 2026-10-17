// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import type { CodeFile } from "../../../../types";
import { FilesPanel } from "../FilesPanel";

const mocks = vi.hoisted(() => {
  const workspace = { files: [] as CodeFile[], activeFileId: null as string | null };
  return {
    desktop: true,
    list: vi.fn(),
    read: vi.fn(),
    code: {
      workspace,
      setActiveFile: (fileId: string | null) => { workspace.activeFileId = fileId; },
      updateFileContent: () => undefined,
      updateWorkspace: vi.fn((update: (current: typeof workspace) => typeof workspace) => { Object.assign(workspace, update(workspace)); }),
      replaceWorkspace: vi.fn(),
    },
    runtime: { effectiveRuntimeId: "runtime", runtimeReady: false, waitingForPreferredRuntime: false, localWorkspace: null, desktopOrigin: null },
    status: { showStatus: () => undefined },
    project: { activeProjectId: "space-a", projectCapabilitiesResolved: true, canWriteProject: true },
    tabs: { openFileTab: () => undefined, openPanelTab: () => undefined, requestUrlPush: () => undefined },
    theme: { resolvedTheme: "light" },
  };
});
vi.mock("@monaco-editor/react", () => ({ default: () => null }));
vi.mock("../editorInlineCompletions", () => ({ registerProxyInlineCompletionProviders: () => undefined }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    workspace: { files: { list: mocks.list, read: mocks.read }, git: { fetchStatus: async () => null } },
  },
}));
vi.mock("../../../../code/useCode", () => ({ useCode: () => mocks.code }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => mocks.runtime }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => mocks.status }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => mocks.project }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => mocks.tabs }));
vi.mock("../../../../hooks/useTouchLikeInput", () => ({ useTouchLikeInput: () => false }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => mocks.desktop }));
vi.mock("../../../../theme/ThemeProvider", () => ({ useTheme: () => mocks.theme }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const folder = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "directory" });
const file = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "file" });

// The explorer wiring: a folder row opens at once and lists its contents, even
// while the workspace is still connecting.
describe("Files panel folder rows", () => {
  let root: Root;
  let container: HTMLDivElement;
  const query = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.list.mockReset();
    mocks.read.mockReset();
    mocks.desktop = true;
    mocks.code.workspace.files = [];
    mocks.code.workspace.activeFileId = null;
    mocks.code.replaceWorkspace.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens a folder and lists it before the workspace reports ready", async () => {
    const skillsListing = deferred<ControllerWorkspaceEntry[]>();
    mocks.list.mockImplementation(({ path }: { path?: string }) => path === "skills" ? skillsListing.promise : Promise.resolve([folder("skills")]));
    await act(async () => root.render(<FilesPanel previewOwnerId={null} />));
    const row = query("files-entry-skills");
    expect(row?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => row?.click());

    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ path: "skills" }));
    expect(query("files-directory-status-skills")?.textContent).toBe("Opening files…");

    await act(async () => skillsListing.resolve([file("skills/write.md")]));
    expect(query("files-directory-status-skills")).toBeNull();
    expect(query("files-entry-skills-write-md")).not.toBeNull();
  });

  it("returns to the same mobile folder and scroll position after opening a file", async () => {
    mocks.desktop = false;
    mocks.list.mockResolvedValue([file("docs/notes.md")]);
    mocks.read.mockResolvedValue({ path: "docs/notes.md", isText: true, contentText: "notes", size: 5 });
    await act(async () => root.render(<FilesPanel previewOwnerId={null} initialRootPath="docs" />));
    const scroller = query("files-explorer-scroll")!;
    scroller.scrollTop = 240;
    await act(async () => query("files-entry-docs-notes-md")?.click());
    expect(query("files-back-button")).not.toBeNull();
    expect(query("files-explorer-scroll")).toBe(scroller);
    expect(scroller.closest("[hidden]")).not.toBeNull();

    await act(async () => query("files-back-button")?.click());
    expect(query("files-explorer-scroll")).toBe(scroller);
    expect(scroller.closest("[hidden]")).toBeNull();
    expect(scroller.scrollTop).toBe(240);
    expect(query("files-entry-docs-notes-md")).not.toBeNull();
  });

  it("keeps dirty and new buffers when Files remounts without an active file", async () => {
    const draft: CodeFile = {
      id: "notes.md", path: "notes.md", label: "notes.md", directory: "", kind: "file",
      generated: "saved", modified: "unsaved notes",
    };
    const newFile = { ...draft, id: "new.md", path: "new.md", generated: "", modified: "", isNew: true };
    mocks.code.workspace.files = [draft, newFile];
    mocks.list.mockResolvedValue([]);
    await act(async () => root.render(<FilesPanel key="first" previewOwnerId={null} />));
    await act(async () => root.render(<FilesPanel key="returned" previewOwnerId={null} />));
    expect(mocks.code.replaceWorkspace).not.toHaveBeenCalled();
    expect(mocks.code.workspace.files).toEqual([draft, newFile]);
  });
});
