// @vitest-environment jsdom

import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useFilesPanelSaveShortcut } from "../useFilesPanelSaveShortcut";

describe("FilesPanel save shortcut ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  let workspace: HTMLDivElement;
  let editor: HTMLDivElement;
  let search: HTMLInputElement;
  let editorRef: RefObject<HTMLElement | null>;
  let previewRef: RefObject<HTMLElement | null>;
  let viewerRef: RefObject<{ mode: string }>;
  let saveDraft: Mock<() => Promise<void>>;
  let saveVersion: Mock<() => Promise<void>>;
  let saveVersionRef: RefObject<(() => Promise<void>) | null>;
  function Harness() {
    useFilesPanelSaveShortcut({ editorContainerRef: editorRef, markdownPreviewContainerRef: previewRef,
      viewerStateRef: viewerRef, saveDraftHandlerRef: { current: saveDraft }, saveVersionHandlerRef: saveVersionRef });
    return null;
  }
  function press(init: KeyboardEventInit = { ctrlKey: true }) {
    const event = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true, ...init });
    search.dispatchEvent(event);
    return event;
  }
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    saveDraft = vi.fn().mockResolvedValue(undefined);
    saveVersion = vi.fn().mockResolvedValue(undefined);
    container = document.createElement("div");
    workspace = document.createElement("div");
    editor = document.createElement("div");
    search = document.createElement("input");
    workspace.appendChild(editor);
    document.body.append(container, workspace, search);
    vi.spyOn(editor, "getClientRects").mockReturnValue([new DOMRect(0, 0, 400, 400)] as unknown as DOMRectList);
    editorRef = { current: editor };
    previewRef = { current: null };
    viewerRef = { current: { mode: "text" } };
    saveVersionRef = { current: saveVersion };
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    workspace.remove();
    search.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["hidden", "inert", "aria-hidden"])("does not save a retained editor under a %s workspace while typing elsewhere", (attribute) => {
    workspace.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
    search.focus();
    expect(press().defaultPrevented).toBe(false);
    expect(press({ metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(saveVersion).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
    workspace.removeAttribute(attribute);
    expect(press().defaultPrevented).toBe(true);
    expect(saveVersion).toHaveBeenCalledOnce();
  });

  it("does not intercept shortcuts when CSS removes the editor from layout", () => {
    vi.mocked(editor.getClientRects).mockReturnValue([] as unknown as DOMRectList);
    expect(press().defaultPrevented).toBe(false);
    expect(saveVersion).not.toHaveBeenCalled();
  });

  it("does not save a visibility-hidden or disconnected editor", () => {
    editor.style.visibility = "hidden";
    expect(press().defaultPrevented).toBe(false);
    editor.style.visibility = "visible";
    editor.remove();
    expect(press().defaultPrevented).toBe(false);
    expect(saveVersion).not.toHaveBeenCalled();
  });

  it("keeps the existing version and draft shortcuts on the visible editor", () => {
    expect(press({ metaKey: true }).defaultPrevented).toBe(true);
    expect(saveVersion).toHaveBeenCalledOnce();
    expect(press({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(press({ altKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({}).defaultPrevented).toBe(false);
    expect(saveVersion).toHaveBeenCalledOnce();
  });

  it("preserves shortcuts in visible markdown preview but rejects an inert preview", () => {
    editorRef.current = null;
    previewRef.current = editor;
    expect(press().defaultPrevented).toBe(true);
    workspace.setAttribute("inert", "");
    expect(press().defaultPrevented).toBe(false);
    expect(saveVersion).toHaveBeenCalledOnce();
  });

  it("does not claim a shortcut with no text viewer or save handler", () => {
    viewerRef.current = { mode: "image" };
    expect(press().defaultPrevented).toBe(false);
    viewerRef.current = { mode: "text" };
    saveVersionRef.current = null;
    expect(press().defaultPrevented).toBe(false);
    expect(saveVersion).not.toHaveBeenCalled();
  });
});
