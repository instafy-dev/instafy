// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../../store";
import type { CodeFile, CodeWorkspace } from "../../types";
import { createDefaultCodeWorkspace } from "../defaults";
import { CodeProvider, useCode } from "../useCode";

const buffer: CodeFile = { id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "edited" };

describe("CodeProvider updates after it unmounted", () => {
  let root: Root;
  let container: HTMLDivElement;
  let update: ReturnType<typeof useCode>["updateWorkspace"];

  function Capture() {
    update = useCode().updateWorkspace;
    return null;
  }
  const markSaved = (workspace: CodeWorkspace): CodeWorkspace => ({
    ...workspace,
    files: workspace.files.map((file) => ({ ...file, generated: file.modified })),
  });
  const storeFile = () => useWorkspaceStore.getState().state.code.files[0];

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const base = useWorkspaceStore.getState().state;
    const state = { ...base, code: { ...createDefaultCodeWorkspace(), files: [buffer], activeFileId: buffer.id } };
    useWorkspaceStore.setState({ state, projects: { "space-a": state }, activeProjectId: "space-a" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<CodeProvider><Capture /></CodeProvider>));
  });
  afterEach(() => {
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps an update that asks for it in the store, for the next provider", async () => {
    await act(async () => root.unmount());
    update(markSaved, { recordHistory: false, keepAfterUnmount: true });
    expect(storeFile()).toMatchObject({ generated: "edited", modified: "edited" });
    expect(useWorkspaceStore.getState().projects["space-a"].code.files[0]).toMatchObject({ generated: "edited" });

    root = createRoot(container);
    await act(async () => root.render(<CodeProvider><Capture /></CodeProvider>));
    await act(async () => update((workspace) => ({ ...workspace, summary: "remounted" })));
    expect(useWorkspaceStore.getState().state.code).toMatchObject({ summary: "remounted" });
    expect(storeFile()).toMatchObject({ generated: "edited", modified: "edited" });
    await act(async () => root.unmount());
  });

  it("keeps an update made as soon as it left the screen, before its effects were cleaned up", async () => {
    // Leaving Studio removes the provider in one commit; the next screen's
    // layout effects run before the provider's passive effects are cleaned up.
    function Left({ onLeft }: { onLeft: () => void }) {
      useLayoutEffect(() => onLeft(), [onLeft]);
      return null;
    }
    function Screen({ studio, onLeft }: { studio: boolean; onLeft: () => void }) {
      return studio ? <CodeProvider><Capture /></CodeProvider> : <Left onLeft={onLeft} />;
    }
    const leave = () => update(markSaved, { recordHistory: false, keepAfterUnmount: true });
    await act(async () => root.render(<Screen studio onLeft={leave} />));
    await act(async () => root.render(<Screen studio={false} onLeft={leave} />));
    expect(storeFile()).toMatchObject({ generated: "edited", modified: "edited" });
    expect(useWorkspaceStore.getState().projects["space-a"].code.files[0]).toMatchObject({ generated: "edited" });
    await act(async () => root.unmount());
  });

  it("drops any other update after it unmounted, as before", async () => {
    await act(async () => root.unmount());
    update(markSaved, { recordHistory: false });
    expect(storeFile()).toMatchObject({ generated: "saved", modified: "edited" });
  });

  it("applies an update to its own state while mounted", async () => {
    await act(async () => update(markSaved, { recordHistory: false, keepAfterUnmount: true }));
    expect(storeFile()).toMatchObject({ generated: "edited", modified: "edited" });
    await act(async () => root.unmount());
  });
});
