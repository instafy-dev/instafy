// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSubmitDispatch } from "../useChatSubmitDispatch";
import { useChatComposerAttachments } from "../useChatComposerAttachments";
import { ChatAttachmentUploadError } from "../../../../lib/chatAttachments";
import type { SubmitConversationOptions } from "../../../../conversations/useConversation";

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
      removeSentImageAttachments: vi.fn(),
      focusInput: vi.fn(),
      isChatInputFocused: vi.fn(() => false),
      latestInputValueRef: { current: "Use this browser" },
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
  it("leaves the composer, staged images, focus and scroll alone for an automatic send", async () => {
    // A failed run's automatic retry fires while the person may be writing the
    // next message (with a screenshot attached) or reading further up.
    const onSubmit = vi.fn(async () => undefined);
    const latestInputValueRef = { current: "Build me a landing page" };
    const options: HookOptions = {
      activeConversationId: "conversation-1",
      clearInputEditor: vi.fn(),
      removeSentImageAttachments: vi.fn(),
      focusInput: vi.fn(),
      isChatInputFocused: vi.fn(() => true),
      latestInputValueRef,
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
        message: "Build me a landing page",
        editorState: null,
        imageFiles: [],
        metadata: { retryOfMessageId: "failure-1" },
        automatic: true,
      });
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(options.removeSentImageAttachments).not.toHaveBeenCalled();
    expect(options.scrollToBottom).not.toHaveBeenCalled();
    expect(options.shouldAutoScrollRef.current).toBe(false);
    expect(options.focusInput).not.toHaveBeenCalled();
    // Even a draft that matches the resent text is the person's to keep.
    expect(options.onInputChange).not.toHaveBeenCalled();
    expect(options.clearInputEditor).not.toHaveBeenCalled();
    expect(latestInputValueRef.current).toBe("Build me a landing page");
    // The send still counts as in flight while it goes out.
    expect(options.setSendingAttachment).toHaveBeenNthCalledWith(1, true);
    expect(options.setSendingAttachment).toHaveBeenLastCalledWith(false);
  });

  describe("when an attachment upload fails", () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    function optionsFor(overrides: Partial<HookOptions> = {}): HookOptions {
      return {
        activeConversationId: "conversation-1",
        clearInputEditor: vi.fn(),
        removeSentImageAttachments: vi.fn(),
        focusInput: vi.fn(),
        isChatInputFocused: vi.fn(() => false),
        latestInputValueRef: { current: "What is in this screenshot?" },
        mentionableAgentHandles: ["octo"],
        onInputChange: vi.fn(),
        onSubmit: vi.fn(async () => {
          throw new ChatAttachmentUploadError("Couldn't reach storage. Check your connection and try again.");
        }),
        scrollToBottom: vi.fn(),
        setSendingAttachment: vi.fn(),
        shouldAutoScrollRef: { current: false },
        ...overrides,
      };
    }
    async function submitWith(options: HookOptions) {
      const resultRef: MutableRefObject<HookResult | null> = { current: null };
      await act(async () => {
        root.render(<Harness options={options} resultRef={resultRef} />);
      });
      let sent: boolean | undefined;
      await act(async () => {
        sent = await resultRef.current?.performSubmit({
          message: "What is in this screenshot?",
          editorState: "{\"root\":{}}",
          imageFiles: [image],
        });
      });
      return sent;
    }

    it("puts the unsent text back in the composer and keeps the staged images", async () => {
      const options = optionsFor({ markImageAttachmentsSending: vi.fn() });
      // Nothing went out, so the caller must not treat the draft as sent.
      await expect(submitWith(options)).resolves.toBe(false);
      // The images were shown as on their way, then freed again.
      expect(options.markImageAttachmentsSending).toHaveBeenNthCalledWith(1, [image], true);
      expect(options.markImageAttachmentsSending).toHaveBeenLastCalledWith([image], false);
      const latestInputValueRef = options.latestInputValueRef;

      // The composer was cleared for the send, then given the draft back.
      expect(options.onInputChange).toHaveBeenNthCalledWith(1, "conversation-1", "", null);
      expect(options.onInputChange).toHaveBeenLastCalledWith(
        "conversation-1",
        "What is in this screenshot?",
        "{\"root\":{}}",
      );
      expect(latestInputValueRef.current).toBe("What is in this screenshot?");
      expect(options.removeSentImageAttachments).not.toHaveBeenCalled();
      expect(options.setSendingAttachment).toHaveBeenLastCalledWith(false);
    });

    it("keeps text typed during the upload below the restored draft", async () => {
      const latestInputValueRef = { current: "What is in this screenshot?" };
      const options = optionsFor({
        latestInputValueRef,
        onSubmit: vi.fn(async () => {
          latestInputValueRef.current = "and one more thing";
          throw new ChatAttachmentUploadError("Attachments must be 20 MB or smaller.");
        }),
      });
      await submitWith(options);
      expect(latestInputValueRef.current).toBe("What is in this screenshot?\n\nand one more thing");
      expect(options.onInputChange).toHaveBeenLastCalledWith(
        "conversation-1",
        "What is in this screenshot?\n\nand one more thing",
        null,
      );
    });

    it("gives the draft back to the chat it was sent from after the person moved to another", async () => {
      // A slow upload: the person sends in one chat, opens another, and the
      // upload fails there. The first chat's composer was emptied for the send.
      const latestInputValueRef = { current: "What is in this screenshot?" };
      const onInputChange = vi.fn();
      const removeSentImageAttachments = vi.fn();
      let failUpload!: () => void;
      const onSubmit = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            failUpload = () =>
              reject(new ChatAttachmentUploadError("Couldn't reach storage. Check your connection and try again."));
          }),
      );
      const options = optionsFor({ latestInputValueRef, onInputChange, onSubmit, removeSentImageAttachments });
      const resultRef: MutableRefObject<HookResult | null> = { current: null };
      await act(async () => {
        root.render(<Harness options={options} resultRef={resultRef} />);
      });
      let sending!: Promise<boolean>;
      await act(async () => {
        sending = resultRef.current!.performSubmit({
          message: "What is in this screenshot?",
          editorState: "{\"root\":{}}",
          imageFiles: [image],
        });
      });
      // The other chat has its own draft in the composer now.
      latestInputValueRef.current = "Notes for the other chat";
      await act(async () => {
        root.render(
          <Harness options={{ ...options, activeConversationId: "conversation-2" }} resultRef={resultRef} />,
        );
      });
      onInputChange.mockClear();
      await act(async () => {
        failUpload();
        await expect(sending).resolves.toBe(false);
      });

      expect(onInputChange).toHaveBeenCalledExactlyOnceWith(
        "conversation-1",
        "What is in this screenshot?",
        "{\"root\":{}}",
      );
      // The chat on screen keeps its own draft, and its tray is not touched.
      expect(latestInputValueRef.current).toBe("Notes for the other chat");
      expect(removeSentImageAttachments).not.toHaveBeenCalled();
    });

    it("leaves other failures to their callers", async () => {
      const options = optionsFor({
        onSubmit: vi.fn(async () => {
          throw new Error("browser task was not dispatched");
        }),
      });
      const resultRef: MutableRefObject<HookResult | null> = { current: null };
      await act(async () => {
        root.render(<Harness options={options} resultRef={resultRef} />);
      });
      await expect(
        resultRef.current!.performSubmit({ message: "hi", editorState: null, imageFiles: [] }),
      ).rejects.toThrow("browser task was not dispatched");
      expect(options.setSendingAttachment).toHaveBeenLastCalledWith(false);
    });
  });

  describe("the staged images of a send", () => {
    const first = new File(["a"], "first.png", { type: "image/png" });

    it("leave the tray once stored, and only the images the send carried", async () => {
      const removeSentImageAttachments = vi.fn();
      const onSubmit = vi.fn(async (_id: string | null, _input: string, submitOptions?: SubmitConversationOptions) => {
        // The submit flow says so as it shows the message, before sending it.
        submitOptions?.onAttachmentsStored?.();
        expect(removeSentImageAttachments).toHaveBeenCalledExactlyOnceWith([first]);
      });
      const options: HookOptions = {
        activeConversationId: "conversation-1",
        clearInputEditor: vi.fn(),
        markImageAttachmentsSending: vi.fn(),
        removeSentImageAttachments,
        focusInput: vi.fn(),
        isChatInputFocused: vi.fn(() => false),
        latestInputValueRef: { current: "Look" },
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
      let sent: boolean | undefined;
      await act(async () => {
        sent = await resultRef.current?.performSubmit({ message: "Look", editorState: null, imageFiles: [first] });
      });
      expect(sent).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(removeSentImageAttachments).toHaveBeenLastCalledWith([first]);
      expect(options.markImageAttachmentsSending).toHaveBeenNthCalledWith(1, [first], true);
    });

    function Composer({
      onSubmit,
      resultRef,
    }: {
      onSubmit: HookOptions["onSubmit"];
      resultRef: MutableRefObject<{
        attachments: ReturnType<typeof useChatComposerAttachments>;
        dispatch: HookResult;
      } | null>;
    }) {
      const attachments = useChatComposerAttachments({
        draftKey: "chat-a",
        isInputLocked: () => false,
        showStatus: vi.fn(),
      });
      const dispatch = useChatSubmitDispatch({
        activeConversationId: "chat-a",
        markImageAttachmentsSending: attachments.markImageAttachmentsSending,
        removeSentImageAttachments: attachments.removeSentImageAttachments,
        focusInput: vi.fn(),
        isChatInputFocused: () => false,
        latestInputValueRef: { current: "" },
        mentionableAgentHandles: [],
        onInputChange: vi.fn(),
        onSubmit,
        scrollToBottom: vi.fn(),
        setSendingAttachment: vi.fn(),
        shouldAutoScrollRef: { current: false },
      });
      resultRef.current = { attachments, dispatch };
      return null;
    }

    async function mountComposer(onSubmit: HookOptions["onSubmit"]) {
      vi.stubGlobal("URL", class extends URL {
        static createObjectURL(file: File) { return `blob:${file.name}`; }
        static revokeObjectURL() {}
      });
      const resultRef: MutableRefObject<{
        attachments: ReturnType<typeof useChatComposerAttachments>;
        dispatch: HookResult;
      } | null> = { current: null };
      await act(async () => {
        root.render(<Composer onSubmit={onSubmit} resultRef={resultRef} />);
      });
      return resultRef;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keep an image pasted during the upload for the next message", async () => {
      let finishUpload!: () => void;
      const onSubmit = vi.fn(
        (_id: string | null, _input: string, submitOptions?: SubmitConversationOptions) =>
          new Promise<void>((resolve) => {
            finishUpload = () => {
              submitOptions?.onAttachmentsStored?.();
              resolve();
            };
          }),
      );
      const composer = await mountComposer(onSubmit);
      const second = new File(["b"], "second.png", { type: "image/png" });
      await act(async () => composer.current!.attachments.attachImageFiles([first]));

      let sending!: Promise<boolean>;
      await act(async () => {
        sending = composer.current!.dispatch.performSubmit({ message: "Look", editorState: null, imageFiles: [first] });
      });
      expect(composer.current!.attachments.imageAttachments.map((item) => [item.file.name, item.sending ?? false]))
        .toEqual([["first.png", true]]);

      // While the first image uploads, the person pastes the next one.
      await act(async () => composer.current!.attachments.attachImageFiles([second]));
      // An image already uploading can't be taken back.
      const uploading = composer.current!.attachments.imageAttachments[0];
      await act(async () => composer.current!.attachments.removeImageAttachment(uploading.id));
      expect(composer.current!.attachments.imageAttachments.map((item) => item.file.name))
        .toEqual(["first.png", "second.png"]);

      await act(async () => {
        finishUpload();
        await expect(sending).resolves.toBe(true);
      });
      expect(composer.current!.attachments.imageAttachments.map((item) => [item.file.name, item.sending ?? false]))
        .toEqual([["second.png", false]]);
    });

    it("can be removed again once a send has failed", async () => {
      const onSubmit = vi.fn(async () => {
        throw new ChatAttachmentUploadError("Too many uploads at once. Wait a moment and try again.");
      });
      const composer = await mountComposer(onSubmit);
      await act(async () => composer.current!.attachments.attachImageFiles([first]));
      await act(async () => {
        await expect(
          composer.current!.dispatch.performSubmit({ message: "Look", editorState: null, imageFiles: [first] }),
        ).resolves.toBe(false);
      });
      const [staged] = composer.current!.attachments.imageAttachments;
      expect(staged.sending).toBe(false);
      await act(async () => composer.current!.attachments.removeImageAttachment(staged.id));
      expect(composer.current!.attachments.imageAttachments).toEqual([]);
    });
  });
});
