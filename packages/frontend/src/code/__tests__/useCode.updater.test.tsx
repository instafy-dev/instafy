// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../../store";
import type { CodeFile } from "../../types";
import { createDefaultCodeWorkspace } from "../defaults";
import { CodeProvider, useCode, useCodeUpdater } from "../useCode";

const buffer: CodeFile = { id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "edited" };

describe("useCodeUpdater", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const base = useWorkspaceStore.getState().state;
    const state = { ...base, code: { ...createDefaultCodeWorkspace(), files: [buffer], activeFileId: buffer.id } };
    useWorkspaceStore.setState({ state, projects: { "space-a": state }, activeProjectId: "space-a" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("writes the buffers without rendering again on every edit", async () => {
    let writerRenders = 0;
    let update!: ReturnType<typeof useCodeUpdater>;
    let modified = "";
    function Writer() {
      writerRenders += 1;
      update = useCodeUpdater();
      return null;
    }
    function Reader() {
      modified = useCode().workspace.files[0]?.modified ?? "";
      return null;
    }
    await act(async () => root.render(<CodeProvider><Writer /><Reader /></CodeProvider>));
    const first = update;

    await act(async () =>
      update((workspace) => ({
        ...workspace,
        files: workspace.files.map((file) => ({ ...file, generated: "latest", modified: "latest" })),
      })),
    );

    expect(modified).toBe("latest");
    expect(writerRenders).toBe(1);
    expect(update).toBe(first);
  });
});
