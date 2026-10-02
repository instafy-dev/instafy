// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { FilesPanel } from "../FilesPanel";

const mocks = vi.hoisted(() => {
  const workspace = { files: [], activeFileId: null };
  return {
    list: vi.fn(),
    code: { workspace, setActiveFile: () => undefined, updateFileContent: () => undefined, updateWorkspace: () => undefined, replaceWorkspace: () => undefined },
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
    workspace: { files: { list: mocks.list }, git: { fetchStatus: async () => null } },
  },
}));
vi.mock("../../../../code/useCode", () => ({ useCode: () => mocks.code }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => mocks.runtime }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => mocks.status }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => mocks.project }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => mocks.tabs }));
vi.mock("../../../../hooks/useTouchLikeInput", () => ({ useTouchLikeInput: () => false }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => true }));
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
});
