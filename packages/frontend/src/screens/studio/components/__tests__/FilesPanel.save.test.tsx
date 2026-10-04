// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFile } from "../../../../types";
import { FilesPanel } from "../FilesPanel";
import { TestCodeProvider, testCodeHandle } from "./filesPanelTestCode";
import { writeWorkspaceFileStaleNotice } from "../workspaceFileStaleNoticeStore";
import { gitBlobOid } from "../../../../utils/gitBlobOid";

const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);
const REV_3 = "3".repeat(40);
const BLOB_A = "a".repeat(40);

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listAt: vi.fn(),
  read: vi.fn(),
  readAt: vi.fn(),
  write: vi.fn(),
  saveChanges: vi.fn(),
  fetchStatus: vi.fn(async () => null),
  syncToRemote: vi.fn(),
  noteSignal: vi.fn(),
  showStatus: vi.fn(),
  versioning: {
    mode: "stateless" as "legacy" | "stateless" | "desktop",
    originId: "origin-1" as string | null,
    recovery: "unknown" as "unknown" | "supported" | "unsupported",
  },
  runtime: {
    effectiveRuntimeId: "runtime-1",
    runtimeReady: false,
    waitingForPreferredRuntime: false,
    localWorkspace: null,
    desktopOrigin: { originId: "origin-1", endpoint: "https://origin.test", mode: "hosted" } as unknown,
  },
  project: { activeProjectId: "space-a", projectCapabilitiesResolved: true, canWriteProject: true },
  tabs: { openFileTab: vi.fn(), openPanelTab: vi.fn(), requestUrlPush: vi.fn() },
  editorCommands: [] as Array<{ keybinding: number; handler: () => void }>,
}));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  function EditorMock(props: { value?: string; onMount?: (editor: unknown, monaco: unknown) => void }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const valueRef = React.useRef(props.value);
    valueRef.current = props.value;
    const onMount = props.onMount;
    React.useEffect(() => {
      onMount?.(
        {
          getContainerDomNode: () => ref.current,
          addCommand: (keybinding: number, handler: () => void) => mocks.editorCommands.push({ keybinding, handler }),
          getValue: () => valueRef.current ?? "",
        },
        { KeyMod: { CtrlCmd: 2048, Shift: 1024 }, KeyCode: { KeyS: 49 } },
      );
    }, [onMount]);
    return React.createElement("div", { ref, "data-testid": "monaco-mock" });
  }
  return { default: EditorMock };
});
vi.mock("../editorInlineCompletions", () => ({ registerProxyInlineCompletionProviders: () => undefined }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    workspace: {
      files: {
        list: mocks.list, listAt: mocks.listAt, read: mocks.read, readAt: mocks.readAt, write: mocks.write,
        delete: vi.fn(), getRawUrl: vi.fn(),
      },
      git: { fetchStatus: mocks.fetchStatus, syncToRemote: mocks.syncToRemote },
      save: { changes: mocks.saveChanges },
      versioning: { noteSignal: mocks.noteSignal },
    },
  },
}));
vi.mock("../../../../code/useCode", async () => {
  const harness = await import("./filesPanelTestCode");
  return { useCode: harness.useTestCode };
});
vi.mock("../../../../workspace/useWorkspaceVersioning", () => ({
  useWorkspaceVersioning: () => ({
    mode: mocks.versioning.mode,
    resolved: true,
    firstPaintMode: mocks.versioning.mode,
    originId: mocks.versioning.originId,
    originMode: "hosted",
    stateless: mocks.versioning.mode === "stateless",
    recovery: mocks.versioning.recovery,
    checkedAt: 1,
    refresh: async () => null,
  }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => mocks.runtime }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => mocks.project }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => mocks.tabs }));
vi.mock("../../../../hooks/useTouchLikeInput", () => ({ useTouchLikeInput: () => false }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => true }));
vi.mock("../../../../theme/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function buffer(patch: Partial<CodeFile> = {}): CodeFile {
  return {
    id: "README.md", path: "README.md", label: "README.md", directory: "", kind: "file",
    generated: "saved", modified: "edited", baseRev: REV_1, blobOid: BLOB_A, originId: "origin-1", ...patch,
  };
}

function saved(rev: string) {
  return {
    ok: true, originId: "origin-1", originMode: "hosted", rev, baseRev: REV_1, committed: true,
    saved: ["README.md"], conflicted: [], rejected: [], recoveryRef: null, via: "apply", report: null,
  };
}

function failed(error: Record<string, unknown>) {
  return {
    ok: false, stage: "apply", originId: "origin-1", originMode: "hosted", applied: false, appliedRev: null,
    error: { routeUnavailable: false, message: "refused", ...error },
  };
}

describe("FilesPanel one Save", () => {
  let root: Root;
  let container: HTMLDivElement;
  const staleEvents: unknown[] = [];
  const onStale = (event: Event) => staleEvents.push((event as CustomEvent).detail);
  const query = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  const file = () => testCodeHandle.current!.workspace.files[0];

  async function render(files: CodeFile[]) {
    await act(async () =>
      root.render(
        <TestCodeProvider initial={{ files, activeFileId: files[0]?.id ?? null }}>
          <FilesPanel previewOwnerId={null} />
        </TestCodeProvider>,
      ),
    );
  }
  // Saves hash the saved bytes with WebCrypto, which resolves on a later task.
  async function settle() {
    await act(async () => {
      for (let tick = 0; tick < 10; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }
  async function pressSave(init: KeyboardEventInit = { ctrlKey: true }) {
    const event = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true, ...init });
    await act(async () => { document.body.dispatchEvent(event); });
    await settle();
    return event;
  }
  async function edit(value: string) {
    await act(async () => testCodeHandle.current!.updateFileContent("README.md", value));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    // A response queued with mockResolvedValueOnce never leaks into the next test.
    mocks.saveChanges.mockReset();
    mocks.listAt.mockReset();
    mocks.readAt.mockReset();
    mocks.editorCommands.length = 0;
    staleEvents.length = 0;
    writeWorkspaceFileStaleNotice(null);
    window.addEventListener("instafy:workspace-file-stale", onStale);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 400, 400)] as unknown as DOMRectList);
    mocks.versioning.mode = "stateless";
    mocks.versioning.originId = "origin-1";
    mocks.versioning.recovery = "unknown";
    mocks.project.canWriteProject = true;
    mocks.listAt.mockImplementation(async ({ path }: { path?: string }) => ({
      ok: true,
      entries: path === "docs"
        ? [{ name: ".instafy.keep", path: "docs/.instafy.keep", kind: "file" }]
        : [{ name: "README.md", path: "README.md", kind: "file", blobOid: BLOB_A }],
      rev: REV_1,
      originId: "origin-1",
      originMode: "hosted",
    }));
    mocks.list.mockResolvedValue([]);
    mocks.saveChanges.mockResolvedValue(saved(REV_2));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.removeEventListener("instafy:workspace-file-stale", onStale);
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders one Save and no draft button, enabled only with unsaved edits", async () => {
    await render([buffer({ modified: "saved" })]);
    const save = query("code-save-button");
    expect(query("code-save-draft-button")).toBeNull();
    expect(save?.getAttribute("aria-label")).toBe("Save");
    expect(save?.getAttribute("title")).toMatch(/^Save \((⌘S|Ctrl\+S)\)$/);
    expect(save?.disabled).toBe(true);
    await edit("edited");
    expect(query("code-save-button")?.disabled).toBe(false);
  });

  it("keeps both legacy saves and today's routing in legacy mode", async () => {
    mocks.versioning.mode = "legacy";
    await render([buffer({ baseRev: undefined, blobOid: undefined, originId: undefined })]);
    expect(query("code-save-draft-button")).not.toBeNull();
    expect(query("code-save-button")?.getAttribute("aria-label")).toBe("Save version");
    expect(mocks.listAt).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalled();
  });

  it("saves once on Cmd/Ctrl+S with the buffer's baseRev and blob, then marks it saved", async () => {
    await render([buffer()]);
    const event = await pressSave({ metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a",
      originId: "origin-1",
      files: [{ path: "README.md", content: "edited", encoding: "utf8" }],
      baseRev: REV_1,
      expected: { "README.md": BLOB_A },
      syncMessage: "Update README.md",
    });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.syncToRemote).not.toHaveBeenCalled();
    expect(file()).toMatchObject({ generated: "edited", modified: "edited", baseRev: REV_2 });
    expect(file().isNew).toBeUndefined();
    expect(query("code-save-button")?.disabled).toBe(true);
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("runs Shift+Cmd/Ctrl+S and both editor commands as the same Save", async () => {
    await render([buffer()]);
    expect((await pressSave({ ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(true);
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    expect(mocks.editorCommands).toHaveLength(2);
    for (const [index, command] of mocks.editorCommands.entries()) {
      await edit(`edit ${index}`);
      await act(async () => command.handler());
      await settle();
    }
    expect(mocks.saveChanges).toHaveBeenCalledTimes(3);
    // The second save is based on the first one's commit.
    expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({ baseRev: REV_2, files: [{ content: "edit 0" }] });
  });

  it("queues exactly one trailing save that uses the first save's revision", async () => {
    const first = deferred<ReturnType<typeof saved>>();
    mocks.saveChanges.mockReturnValueOnce(first.promise).mockResolvedValueOnce(saved(REV_3));
    await render([buffer()]);
    await act(async () => { query("code-save-button")?.click(); });
    expect(query("code-save-button")?.getAttribute("aria-busy")).toBe("true");
    expect(query("code-save-button")?.getAttribute("aria-label")).toBe("Saving");
    await edit("edited more");
    await pressSave();
    await pressSave();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(saved(REV_2)); });
    await settle();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({
      baseRev: REV_2,
      files: [{ path: "README.md", content: "edited more", encoding: "utf8" }],
    });
    expect(file()).toMatchObject({ generated: "edited more", baseRev: REV_3 });
    expect(query("code-save-button")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps the buffer and raises the stale card when the file changed in the space", async () => {
    mocks.saveChanges.mockResolvedValue(failed({ status: 409, code: "head_moved", head: REV_3, paths: ["README.md"] }));
    await render([buffer()]);
    await pressSave();
    expect(file()).toMatchObject({ generated: "saved", modified: "edited", baseRev: REV_1 });
    expect(staleEvents).toEqual([
      expect.objectContaining({ path: "README.md", baseText: "saved", localText: "edited", originId: "origin-1" }),
    ]);
    expect(mocks.showStatus).toHaveBeenCalledWith(
      '"README.md" changed while you were editing. Your edits are kept.',
      "error",
      8000,
      expect.objectContaining({ actionLabel: "Resolve" }),
    );
    const { onAction } = mocks.showStatus.mock.calls[0][3];
    onAction();
    expect(mocks.tabs.openPanelTab).toHaveBeenCalledWith("chat", { activate: true });
  });

  it("explains a refused secret file and opens Secrets", async () => {
    mocks.saveChanges.mockResolvedValue(failed({ status: 422, code: "excluded_path", reason: "secret" }));
    await render([buffer({ id: ".env", path: ".env", label: ".env" })]);
    await pressSave();
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Secret files like .env aren't saved to the space. Add these values in Secrets instead.",
      "error",
      8000,
      expect.objectContaining({ actionLabel: "Open Secrets" }),
    );
    mocks.showStatus.mock.calls[0][3].onAction();
    expect(mocks.tabs.openPanelTab).toHaveBeenCalledWith("secrets", { activate: true });
    expect(file().modified).toBe("edited");
  });

  it("creates a new file on its first Save with expected null on the parent listing's rev", async () => {
    await render([buffer({ generated: "", modified: "", isNew: true, baseRev: null, blobOid: null })]);
    expect(query("code-save-button")?.disabled).toBe(false);
    await pressSave();
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ baseRev: REV_1, expected: { "README.md": null }, files: [{ path: "README.md", content: "", encoding: "utf8" }] }),
    );
    expect(file().isNew).toBeUndefined();
  });

  it("deletes the folder placeholder in the first save into that folder", async () => {
    mocks.saveChanges.mockResolvedValue({ ...saved(REV_2), saved: ["docs/a.md", "docs/.instafy.keep"] });
    await render([buffer({ id: "docs/a.md", path: "docs/a.md", label: "a.md", directory: "docs", generated: "", modified: "hi", isNew: true, baseRev: null, blobOid: null })]);
    await pressSave();
    expect(mocks.listAt).toHaveBeenCalledWith(expect.objectContaining({ path: "docs" }));
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      files: [{ path: "docs/a.md", content: "hi", encoding: "utf8" }],
      deletes: ["docs/.instafy.keep"],
      expected: { "docs/a.md": null },
      baseRev: REV_1,
    }));
  });

  async function deleteFromExplorer(testId: string) {
    const row = query(testId);
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const menuDelete = document.querySelector<HTMLButtonElement>('[data-testid="files-explorer-menu-delete"]');
    expect(menuDelete).not.toBeNull();
    await act(async () => { menuDelete!.click(); });
    await settle();
  }

  it("deletes a file it just saved on top of its own save's revision", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render([buffer()]);
    await pressSave();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    mocks.saveChanges.mockResolvedValueOnce({ ...saved(REV_3), baseRev: REV_2, saved: [] });
    await deleteFromExplorer("files-entry-README-md");
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    // The folder was listed at REV_1; the save moved main to REV_2 with only
    // this edit, so the delete is checked against REV_2 and the saved blob.
    expect(mocks.saveChanges.mock.calls[1][0]).toEqual({
      projectId: "space-a",
      originId: "origin-1",
      deletes: ["README.md"],
      baseRev: REV_2,
      expected: { "README.md": await gitBlobOid("edited") },
    });
  });

  it("deletes a folder with a file it just saved into it on top of that save's revision", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.listAt.mockImplementation(async ({ path }: { path?: string }) => ({
      ok: true,
      entries: path === "docs"
        ? [{ name: ".instafy.keep", path: "docs/.instafy.keep", kind: "file" }]
        : [{ name: "docs", path: "docs", kind: "directory" }],
      rev: REV_1,
      originId: "origin-1",
      originMode: "hosted",
    }));
    mocks.saveChanges.mockResolvedValueOnce({ ...saved(REV_2), saved: ["docs/a.md", "docs/.instafy.keep"] });
    await render([buffer({ id: "docs/a.md", path: "docs/a.md", label: "a.md", directory: "docs", generated: "", modified: "hi", isNew: true, baseRev: null, blobOid: null })]);
    await pressSave();
    mocks.saveChanges.mockResolvedValueOnce({ ...saved(REV_3), baseRev: REV_2, saved: [] });
    await deleteFromExplorer("files-entry-docs");
    expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({ deletes: ["docs"], baseRev: REV_2 });
  });

  it("keeps a listing's revision when the save built on a newer commit", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    // Main had moved to REV_2 (someone else's change) when this save landed.
    mocks.saveChanges.mockResolvedValueOnce({ ...saved(REV_3), baseRev: REV_2 });
    await render([buffer()]);
    await pressSave();
    await deleteFromExplorer("files-entry-README-md");
    expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({ deletes: ["README.md"], baseRev: REV_1 });
  });

  async function closePanel() {
    // The code store stays mounted, as in Studio when a file surface closes.
    await act(async () =>
      root.render(<TestCodeProvider initial={{ files: [], activeFileId: null }}>{null}</TestCodeProvider>),
    );
  }

  it("records a save that finishes after its panel closed", async () => {
    const rev = "6".repeat(40);
    const pending = deferred<ReturnType<typeof saved>>();
    mocks.saveChanges.mockReturnValueOnce(pending.promise);
    await render([buffer()]);
    await act(async () => { query("code-save-button")?.click(); });
    await closePanel();
    await act(async () => { pending.resolve(saved(rev)); });
    await settle();
    expect(file()).toMatchObject({
      generated: "edited",
      modified: "edited",
      baseRev: rev,
      blobOid: await gitBlobOid("edited"),
      originId: "origin-1",
    });
    expect(mocks.showStatus).not.toHaveBeenCalled();

    // Reopened, the panel takes the save's commit event as this tab's own.
    await act(async () =>
      root.render(
        <TestCodeProvider initial={{ files: [], activeFileId: null }}>
          <FilesPanel previewOwnerId={null} />
        </TestCodeProvider>,
      ),
    );
    await settle();
    mocks.listAt.mockClear();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "space-a", data: { rev } } }));
    });
    await settle();
    expect(mocks.listAt).not.toHaveBeenCalled();
  });

  it("reports a save that fails after its panel closed, without a retry it cannot run", async () => {
    const pending = deferred<ReturnType<typeof failed>>();
    mocks.saveChanges.mockReturnValueOnce(pending.promise);
    await render([buffer()]);
    await act(async () => { query("code-save-button")?.click(); });
    await closePanel();
    await act(async () => { pending.resolve(failed({ status: 409, code: "main_busy" })); });
    await settle();
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "The space is busy saving other changes. Try again in a moment.",
      "error",
      8000,
      undefined,
    );
    expect(file()).toMatchObject({ generated: "saved", modified: "edited", baseRev: REV_1 });
  });

  it("leaves a buffer alone when a newer read replaced it during the save", async () => {
    const pending = deferred<ReturnType<typeof saved>>();
    mocks.saveChanges.mockReturnValueOnce(pending.promise);
    await render([buffer()]);
    await act(async () => { query("code-save-button")?.click(); });
    await act(async () =>
      testCodeHandle.current!.updateWorkspace((current) => ({
        ...current,
        files: current.files.map((entry) => ({ ...entry, generated: "theirs", modified: "theirs", baseRev: REV_3, blobOid: "c".repeat(40) })),
      })),
    );
    await act(async () => { pending.resolve(saved("7".repeat(40))); });
    await settle();
    expect(file()).toMatchObject({ generated: "theirs", modified: "theirs", baseRev: REV_3 });
  });

  it("takes its own save's commit event as its own when it arrives before the response", async () => {
    const rev = "8".repeat(40);
    const savedBlob = await gitBlobOid("edited");
    const pending = deferred<ReturnType<typeof saved>>();
    mocks.saveChanges.mockReturnValueOnce(pending.promise);
    await render([buffer()]);
    await act(async () => { query("code-save-button")?.click(); });
    await settle();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    mocks.listAt.mockImplementation(async () => ({
      ok: true,
      entries: [{ name: "README.md", path: "README.md", kind: "file", blobOid: savedBlob }],
      rev,
      originId: "origin-1",
      originMode: "hosted",
    }));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "space-a", data: { rev } } }));
    });
    await settle();
    expect(mocks.listAt).toHaveBeenCalledWith(expect.objectContaining({ rev }));
    await act(async () => { pending.resolve(saved(rev)); });
    await settle();
    expect(staleEvents).toEqual([]);
    expect(file()).toMatchObject({ generated: "edited", modified: "edited", baseRev: rev, blobOid: savedBlob });
  });

  it("still reports a change in the space that arrives while a save runs", async () => {
    const rev = "9".repeat(40);
    const pending = deferred<ReturnType<typeof failed>>();
    mocks.saveChanges.mockReturnValueOnce(pending.promise);
    await render([buffer()]);
    await act(async () => { query("code-save-button")?.click(); });
    await settle();
    mocks.listAt.mockImplementation(async () => ({
      ok: true,
      entries: [{ name: "README.md", path: "README.md", kind: "file", blobOid: "d".repeat(40) }],
      rev,
      originId: "origin-1",
      originMode: "hosted",
    }));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "space-a", data: { rev } } }));
    });
    await settle();
    expect(staleEvents).toEqual([expect.objectContaining({ path: "README.md" })]);
    await act(async () => { pending.resolve(failed({ status: 409, code: "head_moved", head: rev, paths: ["README.md"] })); });
    await settle();
  });

  it("saves a buffer read from the gateway back to it with its revision while the Desktop is the default", async () => {
    mocks.versioning.mode = "desktop";
    mocks.versioning.originId = "desktop-1";
    mocks.saveChanges.mockResolvedValue({ ...saved(REV_2), originId: "gateway-1" });
    await render([buffer({ originId: "gateway-1" })]);
    await pressSave();
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a",
      originId: "gateway-1",
      files: [{ path: "README.md", content: "edited", encoding: "utf8" }],
      baseRev: REV_1,
      expected: { "README.md": BLOB_A },
      syncMessage: "Update README.md",
    });
    expect(file()).toMatchObject({ generated: "edited", baseRev: REV_2, originId: "gateway-1" });
  });

  it("explains an offline Desktop folder for a buffer read from it while the gateway is the default", async () => {
    mocks.versioning.originId = "gateway-1";
    mocks.saveChanges.mockResolvedValue(failed({ status: 0, code: "token_unavailable" }));
    await render([buffer({ originId: "desktop-1", baseRev: null })]);
    await pressSave();
    expect(mocks.readAt).not.toHaveBeenCalled();
    expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a",
      originId: "desktop-1",
      files: [{ path: "README.md", content: "edited", encoding: "utf8" }],
      expected: { "README.md": BLOB_A },
      syncMessage: "Update README.md",
    });
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "The folder on this computer isn't connected. Your edits are kept here.",
      "error",
      8000,
      undefined,
    );
    expect(file()).toMatchObject({ generated: "saved", modified: "edited" });
  });

  describe("a buffer read without a revision (stateless)", () => {
    const readFile = (contentText: string) => ({
      ok: true,
      file: { path: "README.md", isText: true, contentText, rev: REV_3, blobOid: "e".repeat(40), originId: "origin-1" },
    });

    it("saves on the read's revision and blob when the space still holds its base text", async () => {
      mocks.readAt.mockResolvedValue(readFile("saved"));
      await render([buffer({ baseRev: null })]);
      await pressSave();
      expect(mocks.readAt).toHaveBeenCalledExactlyOnceWith({
        projectId: "space-a", path: "README.md", routing: "default", originId: "origin-1",
      });
      expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ baseRev: REV_3, expected: { "README.md": "e".repeat(40) } }),
      );
    });

    it("raises the stale card and saves nothing when the space holds other text", async () => {
      mocks.readAt.mockResolvedValue(readFile("someone else's text"));
      await render([buffer({ baseRev: null })]);
      await pressSave();
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(staleEvents).toEqual([expect.objectContaining({ path: "README.md", baseText: "saved", localText: "edited" })]);
      expect(mocks.showStatus).toHaveBeenCalledWith(
        '"README.md" changed while you were editing. Your edits are kept.',
        "error",
        8000,
        expect.objectContaining({ actionLabel: "Resolve" }),
      );
      expect(file()).toMatchObject({ generated: "saved", modified: "edited", baseRev: null });
    });
  });

  describe("on a Desktop origin", () => {
    beforeEach(() => {
      mocks.versioning.mode = "desktop";
    });
    const desktopSaved = (patch: Record<string, unknown> = {}) => ({
      ...saved(REV_2), originMode: "desktop", committed: false, via: "sync", baseRev: null, ...patch,
    });

    it("sends expected without baseRev and the version message for the publish", async () => {
      mocks.saveChanges.mockResolvedValue(desktopSaved());
      await render([buffer({ baseRev: null })]);
      await pressSave();
      expect(mocks.saveChanges).toHaveBeenCalledExactlyOnceWith({
        projectId: "space-a",
        originId: "origin-1",
        files: [{ path: "README.md", content: "edited", encoding: "utf8" }],
        expected: { "README.md": BLOB_A },
        syncMessage: "Update README.md",
      });
      expect(file()).toMatchObject({ generated: "edited", baseRev: null, blobOid: await gitBlobOid("edited") });
    });

    it("marks the buffer saved to the folder and raises the Desktop card when the space moved on", async () => {
      mocks.saveChanges.mockResolvedValue(desktopSaved({ conflicted: ["README.md"], saved: [] }));
      await render([buffer({ baseRev: null })]);
      await pressSave();
      expect(file()).toMatchObject({ generated: "edited", modified: "edited" });
      expect(staleEvents).toEqual([expect.objectContaining({ path: "README.md", variant: "desktop", localText: "edited" })]);
      expect(mocks.showStatus).toHaveBeenCalledWith(
        '"README.md" changed while you were editing. Your edits are kept.',
        "error",
        8000,
        expect.objectContaining({ actionLabel: "Resolve" }),
      );
    });

    it("keeps an edit that reached the folder but was not published unsaved, with the folder's blob", async () => {
      mocks.saveChanges.mockResolvedValue({
        ...failed({ status: 503, code: "not_saved", report: { failure: "the remote refused the push" } }),
        stage: "sync",
        originMode: "desktop",
        applied: true,
      });
      await render([buffer({ baseRev: null })]);
      await pressSave();
      expect(file()).toMatchObject({ generated: "saved", modified: "edited", blobOid: await gitBlobOid("edited") });
      expect(query("code-save-button")?.disabled).toBe(false);
      // No History drawer lists Unsaved work here, so the copy does not send the user there.
      expect(mocks.showStatus).toHaveBeenCalledWith(
        "Not saved: the remote refused the push. Your edits are kept here. Try again in a moment.",
        "error",
        8000,
        undefined,
      );
      mocks.saveChanges.mockResolvedValue(desktopSaved());
      await pressSave();
      expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({ expected: { "README.md": await gitBlobOid("edited") } });
    });

    it("points a publish failure at Unsaved work once History lists it", async () => {
      mocks.versioning.recovery = "supported";
      mocks.saveChanges.mockResolvedValue({
        ...failed({ status: 503, code: "not_saved", report: { failure: "the remote refused the push" } }),
        stage: "sync",
        originMode: "desktop",
        applied: true,
      });
      await render([buffer({ baseRev: null })]);
      await pressSave();
      expect(mocks.showStatus).toHaveBeenCalledWith(
        "Not saved: the remote refused the push. The work is kept under History, in Unsaved work.",
        "error",
        8000,
        undefined,
      );
    });
  });

  describe("an empty new file that reached the Desktop folder but was not published", () => {
    const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const newFile = () =>
      buffer({ id: "new.md", path: "new.md", label: "new.md", generated: "", modified: "", isNew: true, baseRev: null, blobOid: null });
    const appliedNotPublished = () => ({
      ...failed({ status: 503, code: "not_saved", report: { failure: "the remote refused the push" } }),
      stage: "sync",
      originMode: "desktop",
      applied: true,
    });

    beforeEach(() => {
      mocks.versioning.mode = "desktop";
      mocks.listAt.mockImplementation(async () => ({
        ok: true,
        entries: [{ name: "new.md", path: "new.md", kind: "file", blobOid: EMPTY_BLOB }],
        rev: null,
        originId: "origin-1",
        originMode: "desktop",
      }));
    });

    it("stays unsaved and is saved again against the folder's blob", async () => {
      mocks.saveChanges.mockResolvedValueOnce(appliedNotPublished());
      await render([newFile()]);
      await pressSave();
      expect(mocks.saveChanges.mock.calls[0][0]).toMatchObject({ expected: { "new.md": null } });
      expect(file()).toMatchObject({ generated: "", modified: "", isNew: true, blobOid: EMPTY_BLOB });
      expect(query("code-save-button")?.disabled).toBe(false);
      mocks.saveChanges.mockResolvedValueOnce({
        ...saved(REV_2), originMode: "desktop", committed: false, via: "sync", saved: ["new.md"],
      });
      await pressSave();
      expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
      expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({
        files: [{ path: "new.md", content: "", encoding: "utf8" }],
        expected: { "new.md": EMPTY_BLOB },
      });
      expect(file().isNew).toBeUndefined();
    });

    it("is deleted from the folder, not only dropped here", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mocks.saveChanges.mockResolvedValueOnce(appliedNotPublished());
      await render([newFile()]);
      await pressSave();
      mocks.saveChanges.mockResolvedValueOnce({ ...saved(REV_2), originMode: "desktop", via: "sync", saved: [] });
      await deleteFromExplorer("files-entry-new-md");
      expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({
        deletes: ["new.md"],
        expected: { "new.md": EMPTY_BLOB },
      });
    });
  });

  it("tries a save once more when the space is still loading", async () => {
    mocks.saveChanges
      .mockResolvedValueOnce(failed({ status: 503, code: "fetch_pending", retryAfterMs: 0 }))
      .mockResolvedValueOnce(failed({ status: 503, code: "fetch_pending", retryAfterMs: 0 }));
    await render([buffer()]);
    await pressSave();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(mocks.saveChanges.mock.calls[1][0]).toEqual(mocks.saveChanges.mock.calls[0][0]);
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "The space is still loading. Try again in a moment.",
      "error",
      8000,
      undefined,
    );
  });

  it("keeps a new file in a new folder in the explorer after a reload", async () => {
    mocks.listAt.mockImplementation(async ({ path }: { path?: string }) => ({
      ok: true,
      // The folder is not in the space: its listing answers 404, an empty folder.
      entries: path ? [] : [{ name: "README.md", path: "README.md", kind: "file", blobOid: BLOB_A }],
      rev: REV_1,
      originId: "origin-1",
      originMode: "hosted",
    }));
    await render([buffer({ modified: "saved" })]);
    await act(async () => { query("files-explorer-new-file")?.click(); });
    const input = container.querySelector<HTMLInputElement>('[data-testid="files-explorer-create-file-input"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "notes/todo.md");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(query("files-entry-notes")).not.toBeNull();
    expect(query("files-entry-notes-todo-md")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "space-a", data: { rev: "5".repeat(40) } } }));
    });
    await settle();
    expect(mocks.listAt).toHaveBeenCalledWith(expect.objectContaining({ rev: "5".repeat(40) }));
    expect(query("files-entry-notes")).not.toBeNull();
    expect(query("files-entry-notes-todo-md")).not.toBeNull();
    expect(testCodeHandle.current!.workspace.files.find((entry) => entry.path === "notes/todo.md")?.isNew).toBe(true);
  });

  it("allows writes without a ready runtime in the stateless mode, not in legacy", async () => {
    await render([buffer()]);
    expect(query("files-explorer-new-file")?.disabled).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.versioning.mode = "legacy";
    await render([buffer()]);
    expect(query("files-explorer-new-file")?.disabled).toBe(true);
  });

  it.each(["stateless", "legacy"] as const)("leaves out an empty Modified row (%s)", async (mode) => {
    mocks.versioning.mode = mode;
    await render([buffer({ modifiedAt: null, size: 12 })]);
    const footer = () => container.querySelector("footer")?.textContent ?? "";
    expect(footer()).toContain("Size");
    expect(footer()).not.toContain("Modified");
    expect(footer()).not.toContain("\u2014");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render([buffer({ modifiedAt: "2026-10-04T10:00:00.000Z" })]);
    expect(footer()).toContain("Modified");
  });

  it("disables Save for a read-only member", async () => {
    mocks.project.canWriteProject = false;
    await render([buffer()]);
    expect(query("code-save-button")?.disabled).toBe(true);
    await pressSave();
    expect(mocks.saveChanges).not.toHaveBeenCalled();
  });

  it("never writes a buffer from another origin through legacy routing", async () => {
    mocks.versioning.mode = "legacy";
    mocks.versioning.originId = "gateway-1";
    await render([buffer({ originId: "desktop-1" })]);
    await act(async () => { query("code-save-draft-button")?.click(); });
    await settle();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "The folder on this computer isn't connected. Your edits are kept here.",
      "error",
      6500,
    );
  });

  it("asks the probe to look again after a legacy save", async () => {
    mocks.versioning.mode = "legacy";
    mocks.write.mockResolvedValue({ ok: true, path: "README.md", size: 6, rev: null });
    mocks.runtime.runtimeReady = true;
    try {
      await render([buffer({ baseRev: undefined, blobOid: undefined, originId: undefined })]);
      await act(async () => { query("code-save-draft-button")?.click(); });
      await settle();
      expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
        projectId: "space-a", path: "README.md", content: "edited", runtimeId: "runtime-1",
      });
      expect(mocks.noteSignal).toHaveBeenCalledWith("origin-1", "legacy_saved");
    } finally {
      mocks.runtime.runtimeReady = false;
    }
  });
});
