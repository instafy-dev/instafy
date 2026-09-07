// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatComposerAttachments } from "../useChatComposerAttachments";
import { useChatComposerPreviewTab } from "../useChatComposerPreviewTab";

type Options = Parameters<typeof useChatComposerPreviewTab>[0];
let preview: ReturnType<typeof useChatComposerPreviewTab>;
let attachments: ReturnType<typeof useChatComposerAttachments>;
const showStatus = vi.fn();

function Probe(props: Options) {
  preview = useChatComposerPreviewTab(props);
  attachments = useChatComposerAttachments({
    draftKey: props.conversationId ?? "no-conversation",
    isInputLocked: () => false,
    showStatus,
    onAttachmentsAdded: preview.keepComposerTabOpen,
  });
  return <input aria-label="Composer" />;
}

describe("useChatComposerPreviewTab", () => {
  let root: Root;
  let container: HTMLDivElement;
  let options: Options;
  const keepTabOpen = vi.fn();

  async function render(next: Partial<Options> = {}) {
    options = { ...options, ...next };
    await act(async () => root.render(<Probe {...options} />));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    keepTabOpen.mockReset();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:preview-test"; }
      static revokeObjectURL = vi.fn();
    });
    options = {
      conversationId: "a",
      inputValue: "",
      inputEditorState: null,
      tabs: [{ id: "tab-a", kind: "conversation", conversationId: "a", preview: true }],
      keepTabOpen,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not promote a preview on mount, focus, selection serialization or copying", async () => {
    await render();
    await act(async () => {
      container.querySelector("input")?.focus();
      container.querySelector("input")?.click();
      container.querySelector("input")?.dispatchEvent(new Event("copy", { bubbles: true }));
      preview.keepComposerTabOpenForEdit("", '{"root":{"children":[]}}');
    });
    expect(keepTabOpen).not.toHaveBeenCalled();
  });

  it("keeps a tab as soon as whitespace is typed, before the draft can be cleared", async () => {
    await render();
    await act(async () => preview.keepComposerTabOpenForEdit(" ", "space-state"));
    expect(keepTabOpen).toHaveBeenCalledExactlyOnceWith("tab-a");
    await render({ inputValue: " ", inputEditorState: "space-state", tabs: [{ id: "tab-a", kind: "conversation", conversationId: "a" }] });
    await act(async () => preview.keepComposerTabOpenForEdit("", "empty-state"));
    expect(keepTabOpen).toHaveBeenCalledTimes(1);
  });

  it("recognizes rich content edits but ignores an unchanged restored editor state", async () => {
    await render({ inputValue: "Hello", inputEditorState: "plain-state" });
    await act(async () => preview.keepComposerTabOpenForEdit("Hello", "plain-state"));
    expect(keepTabOpen).not.toHaveBeenCalled();
    await act(async () => preview.keepComposerTabOpenForEdit("Hello", "bold-state"));
    expect(keepTabOpen).toHaveBeenCalledExactlyOnceWith("tab-a");
  });

  it("promotes only the matching conversation preview when explicit work begins", async () => {
    await render({
      tabs: [
        { id: "file", kind: "file", preview: true },
        { id: "tab-b", kind: "conversation", conversationId: "b", preview: true },
        { id: "tab-a", kind: "conversation", conversationId: "a", preview: true },
      ],
    });
    await act(async () => preview.keepComposerTabOpen());
    expect(keepTabOpen).toHaveBeenCalledExactlyOnceWith("tab-a");
  });

  it("does nothing for already kept tabs or a conversation without an open tab", async () => {
    await render({ tabs: [{ id: "tab-a", kind: "conversation", conversationId: "a" }] });
    await act(async () => preview.keepComposerTabOpen());
    await render({ conversationId: "b" });
    await act(async () => preview.keepComposerTabOpenForEdit("draft", "state"));
    expect(keepTabOpen).not.toHaveBeenCalled();
  });

  it("protects attachment-only drafts synchronously and keeps delayed additions bound to their chat", async () => {
    await render();
    const attachToA = attachments.attachImageFiles;
    await render({
      conversationId: "b",
      tabs: [{ id: "tab-b", kind: "conversation", conversationId: "b", preview: true }],
    });
    await act(async () => {
      attachToA([new File(["image"], "a.png", { type: "image/png" })]);
      expect(keepTabOpen).toHaveBeenCalledExactlyOnceWith("tab-a");
    });
    expect(attachments.imageAttachments).toEqual([]);
    await render({ conversationId: "a" });
    expect(attachments.imageAttachments.map((file) => file.file.name)).toEqual(["a.png"]);
  });

  it("does not promote for a canceled picker or rejected attachment", async () => {
    await render();
    await act(async () => {
      attachments.openImagePicker();
      attachments.attachImageFiles([]);
      attachments.attachImageFiles([new File(["text"], "notes.txt", { type: "text/plain" })]);
    });
    expect(keepTabOpen).not.toHaveBeenCalled();
    expect(attachments.imageAttachments).toEqual([]);
  });
});
