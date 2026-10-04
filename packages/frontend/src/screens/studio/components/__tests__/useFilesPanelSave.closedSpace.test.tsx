// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeProvider, useCode } from "../../../../code/useCode";
import { createDefaultCodeWorkspace } from "../../../../code/defaults";
import { useWorkspaceStore } from "../../../../store";
import type { CodeFile, CodeWorkspace } from "../../../../types";
import { gitBlobOid } from "../../../../utils/gitBlobOid";
import { createOwnRevisions, type OwnRevisions } from "../filesVersioning";
import { useFilesPanelSave } from "../useFilesPanelSave";

const mocks = vi.hoisted(() => ({ saveChanges: vi.fn(), readAt: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { files: { readAt: mocks.readAt }, save: { changes: mocks.saveChanges } } },
}));

const REV_1 = "1".repeat(40);
const REV_2 = "2".repeat(40);
const REV_3 = "3".repeat(40);
const BLOB_A = "a".repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const saved = (rev: string, baseRev = REV_1) => ({
  ok: true, originId: "origin-1", originMode: "hosted", rev, baseRev, committed: true,
  saved: ["README.md"], conflicted: [], rejected: [], recoveryRef: null, via: "apply", report: null,
});

function buffer(patch: Partial<CodeFile> = {}): CodeFile {
  return {
    id: "README.md", path: "README.md", label: "README.md", directory: "", kind: "file",
    generated: "saved", modified: "saved", baseRev: REV_1, blobOid: BLOB_A, originId: "origin-1", ...patch,
  };
}

function codeWith(files: CodeFile[]): CodeWorkspace {
  return { ...createDefaultCodeWorkspace(), files, activeFileId: files[0]?.id ?? null };
}

/**
 * The real code provider and store, as in Studio: the Files panel's save
 * hook is the only stand-in.
 */
describe("a save that outlives its space or Studio", () => {
  let root: Root;
  let container: HTMLDivElement;
  let own: OwnRevisions;
  let save: () => Promise<void>;
  let code: ReturnType<typeof useCode>;
  const presentFailure = vi.fn();

  function Panel() {
    code = useCode();
    const workspaceRef = useRef(code.workspace);
    workspaceRef.current = code.workspace;
    const directoryRevsRef = useRef<Record<string, string | null>>({ "": REV_1 });
    const keepFoldersRef = useRef(new Set<string>());
    const activeProjectId = useWorkspaceStore((store) => store.activeProjectId) || null;
    save = useFilesPanelSave({
      enabled: true,
      versioning: { mode: "stateless", originId: "origin-1" },
      activeProjectId,
      readOnly: false,
      originAvailable: true,
      getActiveFile: () =>
        workspaceRef.current.files.find((file) => file.id === workspaceRef.current.activeFileId) ?? null,
      getFile: (fileId) => workspaceRef.current.files.find((file) => file.id === fileId) ?? null,
      getPendingContent: (file) => file.modified,
      updateWorkspace: code.updateWorkspace,
      directoryRevsRef,
      keepFoldersRef,
      loadDirectory: async () => [],
      ownRevisions: own,
      presentFailure,
    }).save;
    return null;
  }

  function openSpaces(spaces: Record<string, CodeWorkspace>, active: string) {
    const base = useWorkspaceStore.getState().state;
    const projects = Object.fromEntries(Object.entries(spaces).map(([id, workspace]) => [id, { ...base, code: workspace }]));
    useWorkspaceStore.setState({ projects, activeProjectId: active, state: projects[active], history: [], future: [] });
  }
  async function renderStudio(panelKey: string | null = null) {
    await act(async () =>
      root.render(<CodeProvider>{panelKey === null ? <Panel /> : <Panel key={panelKey} />}</CodeProvider>),
    );
  }
  async function settle() {
    await act(async () => {
      for (let tick = 0; tick < 10; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }
  async function startSave() {
    // The user types, then saves.
    await act(async () => code.updateFileContent("README.md", "edited"));
    const pending = deferred<ReturnType<typeof saved>>();
    mocks.saveChanges.mockReturnValueOnce(pending.promise);
    await act(async () => { void save(); });
    await settle();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    return pending;
  }
  async function saveAgainOnTopOfIt() {
    await act(async () => code.updateFileContent("README.md", "edited more"));
    mocks.saveChanges.mockResolvedValueOnce(saved(REV_3, REV_2));
    await act(async () => { await save(); });
    await settle();
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(mocks.saveChanges.mock.calls[1][0]).toMatchObject({
      baseRev: REV_2,
      expected: { "README.md": await gitBlobOid("edited") },
      files: [{ path: "README.md", content: "edited more", encoding: "utf8" }],
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.saveChanges.mockReset();
    own = createOwnRevisions();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the result when Studio closed first, so the next save builds on it", async () => {
    openSpaces({ "space-a": codeWith([buffer()]) }, "space-a");
    await renderStudio();
    const pending = await startSave();
    // Leave Studio: the code provider unmounts with the panel.
    await act(async () => root.unmount());
    await act(async () => { pending.resolve(saved(REV_2)); });
    await settle();
    const savedBlob = await gitBlobOid("edited");
    expect(useWorkspaceStore.getState().state.code.files[0]).toMatchObject({
      generated: "edited", modified: "edited", baseRev: REV_2, blobOid: savedBlob,
    });
    expect(useWorkspaceStore.getState().projects["space-a"].code.files[0]).toMatchObject({ baseRev: REV_2 });

    root = createRoot(container);
    await renderStudio();
    expect(code.workspace.files[0]).toMatchObject({ generated: "edited", baseRev: REV_2, blobOid: savedBlob });
    await saveAgainOnTopOfIt();
  });

  it("keeps the result on its space when the user switched spaces first", async () => {
    openSpaces({ "space-a": codeWith([buffer()]), "space-b": codeWith([]) }, "space-a");
    // The Files panel is keyed by the space, as in Studio.
    await renderStudio("space-a");
    const pending = await startSave();
    await act(async () => useWorkspaceStore.getState().switchProject("space-b"));
    await renderStudio("space-b");
    await act(async () => { pending.resolve(saved(REV_2)); });
    await settle();
    expect(useWorkspaceStore.getState().projects["space-a"].code.files[0]).toMatchObject({
      generated: "edited", modified: "edited", baseRev: REV_2, blobOid: await gitBlobOid("edited"),
    });
    expect(code.workspace.files).toEqual([]);
    expect(useWorkspaceStore.getState().state.code.files).toEqual([]);

    await act(async () => useWorkspaceStore.getState().switchProject("space-a"));
    await renderStudio("space-a");
    expect(code.workspace.files[0]).toMatchObject({ generated: "edited", baseRev: REV_2 });
    await saveAgainOnTopOfIt();
  });

  it("keeps the result on its space when a panel that stays open moved to another space", async () => {
    openSpaces({ "space-a": codeWith([buffer()]), "space-b": codeWith([buffer({ generated: "b", modified: "b" })]) }, "space-a");
    await renderStudio();
    const pending = await startSave();
    await act(async () => useWorkspaceStore.getState().switchProject("space-b"));
    await act(async () => { pending.resolve(saved(REV_2)); });
    await settle();
    expect(useWorkspaceStore.getState().projects["space-a"].code.files[0]).toMatchObject({ generated: "edited", baseRev: REV_2 });
    // Space B's file at the same path is left alone.
    expect(code.workspace.files[0]).toMatchObject({ generated: "b", modified: "b", baseRev: REV_1 });
    expect(presentFailure).not.toHaveBeenCalled();
  });
});
