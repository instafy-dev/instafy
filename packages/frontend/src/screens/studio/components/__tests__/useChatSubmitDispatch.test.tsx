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
});
