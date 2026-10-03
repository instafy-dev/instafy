// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSubmitDispatch } from "../useChatSubmitDispatch";
import { ChatAttachmentUploadError } from "../../../../lib/chatAttachments";

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
      clearImageAttachments: vi.fn(),
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
      clearImageAttachments: vi.fn(),
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
    expect(options.clearImageAttachments).not.toHaveBeenCalled();
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
        clearImageAttachments: vi.fn(),
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
      await act(async () => {
        await resultRef.current?.performSubmit({
          message: "What is in this screenshot?",
          editorState: "{\"root\":{}}",
          imageFiles: [image],
        });
      });
    }

    it("puts the unsent text back in the composer and keeps the staged images", async () => {
      const options = optionsFor();
      await submitWith(options);
      const latestInputValueRef = options.latestInputValueRef;

      // The composer was cleared for the send, then given the draft back.
      expect(options.onInputChange).toHaveBeenNthCalledWith(1, "conversation-1", "", null);
      expect(options.onInputChange).toHaveBeenLastCalledWith(
        "conversation-1",
        "What is in this screenshot?",
        "{\"root\":{}}",
      );
      expect(latestInputValueRef.current).toBe("What is in this screenshot?");
      expect(options.clearImageAttachments).not.toHaveBeenCalled();
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
});
