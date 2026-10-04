// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../../store";
import type { CodeFile, CodeWorkspace } from "../../types";
import { createDefaultCodeWorkspace } from "../defaults";
import { CodeProvider, useCode } from "../useCode";

function file(id: string, text: string): CodeFile {
  return { id, path: id, label: id, generated: text, modified: text };
}

function codeWith(files: CodeFile[]): CodeWorkspace {
  return { ...createDefaultCodeWorkspace(), files, activeFileId: files[0]?.id ?? null };
}

describe("CodeProvider and the store's code", () => {
  let root: Root;
  let container: HTMLDivElement;
  let code: ReturnType<typeof useCode>;

  function Capture() {
    code = useCode();
    return null;
  }
  const storeCode = () => useWorkspaceStore.getState().state.code;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const base = useWorkspaceStore.getState().state;
    const spaceA = { ...base, code: codeWith([file("a.md", "space a")]) };
    const spaceB = { ...base, code: codeWith([file("b.md", "space b")]) };
    useWorkspaceStore.setState({
      state: spaceA,
      projects: { "space-a": spaceA, "space-b": spaceB },
      activeProjectId: "space-a",
      history: [],
      future: [],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Mounted from the store, so its first push changes nothing there.
    await act(async () => root.render(<CodeProvider><Capture /></CodeProvider>));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("takes a change made in the store right after it mounted", async () => {
    await act(async () =>
      useWorkspaceStore.getState().updateCode((current) => ({
        ...current,
        files: current.files.map((entry) => ({ ...entry, generated: "saved elsewhere", modified: "saved elsewhere" })),
      })),
    );
    expect(code.workspace.files).toEqual([expect.objectContaining({ id: "a.md", generated: "saved elsewhere" })]);
  });

  it("follows a space switch made before any edit, and keeps its next change in that space", async () => {
    await act(async () => useWorkspaceStore.getState().switchProject("space-b"));
    expect(code.workspace.files).toEqual([expect.objectContaining({ id: "b.md", modified: "space b" })]);

    await act(async () => code.updateFileContent("b.md", "space b, edited"));
    expect(storeCode().files).toEqual([expect.objectContaining({ id: "b.md", modified: "space b, edited" })]);
    expect(useWorkspaceStore.getState().projects["space-b"].code.files).toEqual([
      expect.objectContaining({ id: "b.md", modified: "space b, edited" }),
    ]);
    expect(useWorkspaceStore.getState().projects["space-a"].code.files).toEqual([
      expect.objectContaining({ id: "a.md", modified: "space a" }),
    ]);
  });

  it("still writes its own changes to the store and keeps their undo history", async () => {
    await act(async () => code.updateFileContent("a.md", "typed"));
    expect(storeCode().files[0]).toMatchObject({ modified: "typed" });
    expect(code.historyLength).toBe(1);
    await act(async () => code.undo());
    expect(code.workspace.files[0]).toMatchObject({ modified: "space a" });
    expect(storeCode().files[0]).toMatchObject({ modified: "space a" });
  });
});
