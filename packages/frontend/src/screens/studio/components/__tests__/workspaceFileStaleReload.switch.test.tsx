// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultCodeWorkspace } from "../../../../code/defaults";
import { CodeProvider, useCode, useCodeUpdater } from "../../../../code/useCode";
import { controllerClient } from "../../../../sdk/instafy";
import { useWorkspaceStore } from "../../../../store";
import type { CodeFile, CodeWorkspace } from "../../../../types";
import { reloadStaleWorkspaceFile } from "../workspaceFileStaleReload";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { revertPaths: vi.fn() }, files: { readAt: vi.fn() } } },
}));

const readme = (generated: string, modified: string, extra: Partial<CodeFile> = {}): CodeFile => ({
  id: "README.md", path: "README.md", label: "README.md", generated, modified, ...extra,
});

describe("Reload latest across a space switch", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    const base = useWorkspaceStore.getState().state;
    const space = (file: CodeFile) => ({ ...base, code: { ...createDefaultCodeWorkspace(), files: [file], activeFileId: file.id } });
    const spaceA = space(readme("a base", "a edits", { baseRev: "rev-a0", blobOid: "blob-a0", originId: "gw-a" }));
    const spaceB = space(readme("b saved", "b unsaved", { baseRev: "rev-b", blobOid: "blob-b", originId: "gw-b" }));
    useWorkspaceStore.setState({ state: spaceA, projects: { "space-a": spaceA, "space-b": spaceB }, activeProjectId: "space-a" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("writes nothing into the next space's buffer when the read answers after a switch", async () => {
    let update!: ReturnType<typeof useCodeUpdater>;
    let shown: CodeWorkspace | null = null;
    function Writer() {
      update = useCodeUpdater();
      return null;
    }
    function Reader() {
      shown = useCode().workspace;
      return null;
    }
    await act(async () => root.render(<CodeProvider><Writer /><Reader /></CodeProvider>));

    let answer!: (value: unknown) => void;
    vi.mocked(controllerClient.workspace.files.readAt).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }) as never,
    );
    const opened = vi.fn();
    window.addEventListener("instafy:open-workspace-file", opened);
    const reload = reloadStaleWorkspaceFile({
      notice: { projectId: "space-a", path: "README.md", label: "README.md", baseText: "a base", localText: "a edits", detectedAt: 1 },
      projectId: "space-a",
      versioning: { mode: "stateless", originId: "gw-a" },
      runtimeId: null,
      updateWorkspace: update,
    });

    await act(async () => useWorkspaceStore.getState().switchProject("space-b"));
    expect(shown!.files[0]).toMatchObject({ generated: "b saved", modified: "b unsaved" });

    await act(async () => {
      answer({
        ok: true,
        file: {
          path: "README.md", size: 8, encoding: "utf8", mimeType: "text/markdown", contentBase64: "",
          contentText: "a latest", isText: true, rev: "rev-a", blobOid: "blob-a", originId: "gw-a",
        },
      });
      await reload;
    });

    window.removeEventListener("instafy:open-workspace-file", opened);
    expect(await reload).toEqual({ status: "superseded" });
    expect(opened).not.toHaveBeenCalled();
    const expected = readme("b saved", "b unsaved", { baseRev: "rev-b", blobOid: "blob-b", originId: "gw-b" });
    expect(shown!.files[0]).toEqual(expected);
    expect(useWorkspaceStore.getState().state.code.files[0]).toEqual(expected);
  });
});
