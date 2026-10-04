// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFile } from "../../types";
import { StudioDraftNavigationGuard } from "../../navigation/StudioDraftNavigationGuard";
import { StudioDraftsProvider, useStudioDraftSnapshot } from "../StudioDrafts";
import { useFileBufferDrafts } from "../StudioFileBufferDrafts";

vi.mock("../../components/aria/StudioModal", () => ({
  StudioDialogModal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));

const file = (path: string, patch: Partial<CodeFile> = {}): CodeFile => ({
  id: path, path, label: path, generated: "saved", modified: "saved", ...patch,
});

describe("Files buffers as Studio drafts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let router: ReturnType<typeof createMemoryRouter>;
  let files: CodeFile[];
  let enabled: boolean;
  let keys: string[] = [];
  let setInput: (next: { files: CodeFile[]; enabled: boolean }) => void = () => undefined;

  function Buffers() {
    const [input, set] = useState({ files, enabled });
    setInput = set;
    useFileBufferDrafts({ projectId: "space-a", files: input.files, enabled: input.enabled });
    keys = useStudioDraftSnapshot().drafts.map((draft) => draft.key);
    return null;
  }
  function App() {
    return (
      <StudioDraftsProvider>
        <Buffers />
        <StudioDraftNavigationGuard><p>Studio</p></StudioDraftNavigationGuard>
      </StudioDraftsProvider>
    );
  }
  async function rerender() {
    await act(async () => setInput({ files, enabled }));
  }
  const dialog = () => container.querySelector('[role="dialog"]');

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    files = [file("README.md", { modified: "edited" }), file("clean.md"), file("new.md", { generated: "", modified: "", isNew: true })];
    enabled = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    router = createMemoryRouter([{ path: "*", element: <App /> }], { initialEntries: ["/studio?panel=code"] });
    await act(async () => root.render(<RouterProvider router={router} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    router.dispose();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("registers one draft per unsaved or never-saved buffer", () => {
    expect(keys.sort()).toEqual(["files:space-a:README.md", "files:space-a:new.md"]);
  });

  it("drops a buffer's draft once it is saved, and every draft in legacy mode", async () => {
    files = [file("README.md"), files[2]];
    await rerender();
    expect(keys).toEqual(["files:space-a:new.md"]);
    enabled = false;
    await rerender();
    expect(keys).toEqual([]);
  });

  it("does not warn on panel switches but warns on leaving Studio with a file line", async () => {
    await act(async () => router.navigate("/studio?panel=chat"));
    expect(dialog()).toBeNull();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () => router.navigate("/home"));
    expect(dialog()?.textContent).toContain("You have unsaved edits in 2 files. They stay on this device until you save.");
    const buttons = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
    expect(buttons).toEqual(["Keep editing", "Leave"]);
    expect(dialog()?.textContent).not.toContain("\u2014");
  });
});
