// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import { FilesExplorerTree } from "../FilesExplorerTree";

const folder = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "directory" });
const file = (path: string): ControllerWorkspaceEntry => ({ path, name: path.split("/").pop()!, kind: "file" });

describe("Files explorer folder rows", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: ComponentProps<typeof FilesExplorerTree>;
  const query = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  async function render(patch: Partial<typeof props> = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(<FilesExplorerTree {...props} />));
  }
  // Separate acts: React Aria listens for the key release only after the key-down render commits.
  async function pressKey(element: HTMLElement, key: string) {
    await act(async () => element.focus());
    await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    await act(async () => { element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true })); });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    props = {
      rootPath: "", entriesMap: { "": [folder("skills"), file("notes.md")] }, expandedDirectories: new Set(),
      expandedMarkdownPaths: new Set(), markdownOutlines: {}, markdownOutlineLoadingPaths: new Set(),
      collapsedMarkdownSectionKeys: new Set(), activePath: null, dirtyFileIds: new Set(),
      normalizePath: (path) => path, isInstafyManagedPath: () => false, isMarkdownWorkspacePath: () => false,
      onSelect: vi.fn(), onToggle: vi.fn(), onToggleMarkdownOutline: vi.fn(), onSelectMarkdownSection: vi.fn(),
      onToggleMarkdownSectionCollapse: vi.fn(), onFocus: vi.fn(), onEntryContextMenu: vi.fn(),
      createFile: null, createFileInputRef: { current: null }, onCreateFileDraftChange: vi.fn(),
      onCreateFileCommit: vi.fn(), onCreateFileCancel: vi.fn(), createFolder: null,
      createFolderInputRef: { current: null }, onCreateFolderDraftChange: vi.fn(),
      onCreateFolderCommit: vi.fn(), onCreateFolderCancel: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("toggles a folder from a click on its name, Enter or Space, and keeps Focus separate", async () => {
    await render();
    const row = query("files-entry-skills")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");

    await act(async () => row.click());
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    await pressKey(row, "Enter");
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    await pressKey(row, " ");
    expect(props.onToggle).toHaveBeenCalledTimes(3);
    expect(props.onToggle).toHaveBeenCalledWith(folder("skills"));
    expect(props.onFocus).not.toHaveBeenCalled();

    await render({ expandedDirectories: new Set(["skills"]), entriesMap: { "": [folder("skills")], skills: [] } });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await act(async () => query("files-focus-skills")!.click());
    expect(props.onFocus).toHaveBeenCalledExactlyOnceWith("skills");
    expect(props.onToggle).toHaveBeenCalledTimes(3);
  });

  it("names the unsaved dot for screen readers", async () => {
    await render({ dirtyFileIds: new Set(["notes.md"]) });
    const row = query("files-entry-notes-md")!;
    const dot = row.querySelector('[role="img"]');
    expect(dot?.getAttribute("aria-label")).toBe("Unsaved changes");
    expect(dot?.textContent).toBe("\u25cf");
    expect(query("files-entry-skills")!.querySelector('[role="img"]')).toBeNull();
  });

  it("shows an expanded folder's loading line until its listing arrives", async () => {
    const renderDirectoryStatus = vi.fn((path: string) => <span>Loading files… ({path})</span>);
    await render({ expandedDirectories: new Set(["skills"]), renderDirectoryStatus });
    expect(query("files-directory-status-skills")?.textContent).toBe("Loading files… (skills)");
    expect(renderDirectoryStatus).toHaveBeenCalledWith("skills");

    await render({ entriesMap: { "": [folder("skills")], skills: [file("skills/write.md")] } });
    expect(query("files-directory-status-skills")).toBeNull();
    expect(query("files-entry-skills-write-md")).not.toBeNull();
  });

  it("shows no line for a collapsed folder or a folder with nothing to report", async () => {
    const renderDirectoryStatus = vi.fn(() => null);
    await render({ renderDirectoryStatus });
    expect(renderDirectoryStatus).not.toHaveBeenCalled();
    await render({ expandedDirectories: new Set(["skills"]) });
    expect(query("files-directory-status-skills")).toBeNull();
  });
});
