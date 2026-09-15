// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSubmitDispatch } from "../useChatSubmitDispatch";

type HookOptions = Parameters<typeof useChatSubmitDispatch>[0];
type HookResult = ReturnType<typeof useChatSubmitDispatch>;

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useChatSubmitDispatch(options);
  return null;
}

describe("useChatSubmitDispatch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("forwards an explicit Personal Browser runtime override", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const options: HookOptions = {
      activeConversationId: "conversation-1",
      draftScopeKey: "user:project:conversation-1",
      clearSubmittedImageAttachments: vi.fn(),
      clearConversationDraftIfUnchanged: vi.fn(() => true),
      focusInput: vi.fn(),
      isChatInputFocused: vi.fn(() => false),
      latestInputValueRef: { current: "Use this browser" },
      latestInputEditorStateRef: { current: null },
      mentionableAgentHandles: ["octo"],
      onInputChange: vi.fn(),
      onSubmit,
      scrollToBottom: vi.fn(),
      setSendingAttachment: vi.fn(),
      shouldAutoScrollRef: { current: false },
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current?.performSubmit({
        message: "Use this browser",
        editorState: null,
        imageFiles: [],
        metadata: { browserTransport: "desktop-personal" },
        runtimeOverride: {
          runtimeId: "desktop-personal-project-1",
          runtimeDisplayName: "Personal Browser on this device",
          preferRuntime: false,
        },
      });
    });

    expect(onSubmit).toHaveBeenCalledWith(
      "conversation-1",
      "Use this browser",
      expect.objectContaining({
        metadata: { browserTransport: "desktop-personal" },
        runtimeOverride: {
          runtimeId: "desktop-personal-project-1",
          runtimeDisplayName: "Personal Browser on this device",
          preferRuntime: false,
        },
      }),
    );
  });

  function optionsForUpload(): HookOptions {
    return {
      activeConversationId: "chat-a", draftScopeKey: "user:project-a:chat-a",
      clearSubmittedImageAttachments: vi.fn(),
      clearConversationDraftIfUnchanged: vi.fn(() => true), clearInputEditor: vi.fn(),
      focusInput: vi.fn(), isChatInputFocused: () => false,
      latestInputValueRef: { current: "Inspect this image" }, latestInputEditorStateRef: { current: "editor-a" },
      mentionableAgentHandles: [], onInputChange: vi.fn(), onSubmit: vi.fn(async () => undefined),
      scrollToBottom: vi.fn(), setSendingAttachment: vi.fn(), shouldAutoScrollRef: { current: false },
    };
  }
  async function mount(options: HookOptions, resultRef: MutableRefObject<HookResult | null>) {
    await act(async () => root.render(<Harness options={options} resultRef={resultRef} />));
  }
  const imagePayload = () => ({ message: "Inspect this image", editorState: "editor-a", imageFiles: [new File(["image"], "photo.png", { type: "image/png" })] });

  it("keeps the exact draft, editor and images on upload rejection, without reporting submission", async () => {
    const options = optionsForUpload();
    let complete!: (value: { ok: false; reason: "image_upload_failed" }) => void;
    options.onSubmit = vi.fn(() => new Promise<{ ok: false; reason: "image_upload_failed" }>((resolve) => { complete = resolve; }));
    const resultRef = { current: null } as MutableRefObject<HookResult | null>;
    await mount(options, resultRef);
    let pending!: Promise<boolean>;
    await act(async () => { pending = resultRef.current!.performSubmit(imagePayload()); });
    expect(options.latestInputValueRef.current).toBe("Inspect this image");
    expect(options.latestInputEditorStateRef.current).toBe("editor-a");
    expect(options.onInputChange).not.toHaveBeenCalled();
    await act(async () => complete({ ok: false, reason: "image_upload_failed" }));
    expect(await pending).toBe(false);
    expect(options.clearInputEditor).not.toHaveBeenCalled();
    expect(options.clearConversationDraftIfUnchanged).not.toHaveBeenCalled();
    expect(options.clearSubmittedImageAttachments).not.toHaveBeenCalled();
    expect(options.setSendingAttachment).toHaveBeenLastCalledWith(false);
  });

  it("clears the submitted source draft and files on success, without clearing another chat's equal-text editor", async () => {
    const options = optionsForUpload();
    let complete!: () => void;
    options.onSubmit = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const resultRef = { current: null } as MutableRefObject<HookResult | null>;
    await mount(options, resultRef);
    const payload = imagePayload();
    let pending!: Promise<boolean>;
    await act(async () => { pending = resultRef.current!.performSubmit(payload); });
    const next = { ...options, activeConversationId: "chat-b", draftScopeKey: "user:project-b:chat-b", clearInputEditor: vi.fn() };
    await mount(next, resultRef);
    await act(async () => complete());
    expect(await pending).toBe(true);
    expect(options.clearConversationDraftIfUnchanged).toHaveBeenCalledWith("chat-a", "Inspect this image", "editor-a");
    expect(options.clearSubmittedImageAttachments).toHaveBeenCalledWith(payload.imageFiles);
    expect(options.latestInputValueRef.current).toBe("Inspect this image");
    expect(options.clearInputEditor).not.toHaveBeenCalled();
    expect(next.clearInputEditor).not.toHaveBeenCalled();
  });

  it("preserves a newer editor-only change during an upload", async () => {
    const options = optionsForUpload();
    let complete!: () => void;
    options.onSubmit = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    options.clearConversationDraftIfUnchanged = vi.fn(() => false);
    const resultRef = { current: null } as MutableRefObject<HookResult | null>;
    await mount(options, resultRef);
    await act(async () => { void resultRef.current!.performSubmit(imagePayload()); });
    options.latestInputEditorStateRef.current = "new mention target";
    await act(async () => complete());
    expect(options.latestInputValueRef.current).toBe("Inspect this image");
    expect(options.latestInputEditorStateRef.current).toBe("new mention target");
    expect(options.clearInputEditor).not.toHaveBeenCalled();
  });

  it("clears the unchanged live image draft only after accepted submission", async () => {
    const options = optionsForUpload();
    const resultRef = { current: null } as MutableRefObject<HookResult | null>;
    await mount(options, resultRef);
    await act(async () => { expect(await resultRef.current!.performSubmit(imagePayload())).toBe(true); });
    expect(options.clearConversationDraftIfUnchanged).toHaveBeenCalledWith("chat-a", "Inspect this image", "editor-a");
    expect(options.clearInputEditor).toHaveBeenCalledOnce();
    expect(options.latestInputValueRef.current).toBe("");
    expect(options.latestInputEditorStateRef.current).toBeNull();
  });
});
