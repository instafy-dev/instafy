// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput, type ChatInputHandle } from "../chat-input/ChatInput";
import {
  CHAT_INPUT_CONTROL_HEIGHT_CLASS,
  CHAT_INPUT_LINE_HEIGHT_PX,
  CHAT_INPUT_OVERLAY_TOP_CLASS,
  CHAT_INPUT_VERTICAL_PADDING_CLASS,
  resolveChatInputMaxHeightPx,
} from "../chat-input/chatInputGrowth";
import { COARSE_POINTER_MEDIA_QUERY } from "../../../../hooks/useCoarsePointer";

describe("ChatInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.restoreAllMocks();
    (window as typeof window & { __browserUseFakeClipboardCleanup?: () => void }).__browserUseFakeClipboardCleanup?.();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("installs the Browser Use virtual clipboard shim for dev automation", async () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();

    await act(async () => {
      root.render(
        <ChatInput
          value=""
          editorState={null}
          placeholder="Ask for something..."
          agentHandles={[]}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />,
      );
    });

    expect((window as typeof window & { __browserUseFakeClipboard?: { installed?: boolean } }).__browserUseFakeClipboard?.installed).toBe(
      true,
    );
    expect((navigator.clipboard as Navigator["clipboard"] & { __browserUseFakeClipboard?: boolean }).__browserUseFakeClipboard).toBe(true);

    await navigator.clipboard.writeText("clipboard smoke");

    await expect(navigator.clipboard.readText()).resolves.toBe("clipboard smoke");
    expect(container.querySelector('[data-testid="chat-input"]')).not.toBeNull();
  });

  it("clears visible editor text when the controlled draft resets", async () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();

    await act(async () => {
      root.render(
        <ChatInput
          value="/goal count to 3"
          editorState={null}
          placeholder="Ask for something..."
          agentHandles={[]}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />,
      );
    });

    const input = container.querySelector('[data-testid="chat-input"]');
    expect(input?.textContent).toBe("/goal count to 3");

    await act(async () => {
      root.render(
        <ChatInput
          value=""
          editorState={null}
          placeholder="Ask for something..."
          agentHandles={[]}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />,
      );
    });

    expect(input?.textContent).toBe("");
  });

  it("preserves a local edit across a stale controlled rerender", async () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    const inputRef = createRef<ChatInputHandle>();
    const staleEmptyEditorState = JSON.stringify({
      root: {
        children: [
          {
            children: [],
            direction: null,
            format: "",
            indent: 0,
            type: "paragraph",
            version: 1,
            textFormat: 0,
            textStyle: "",
          },
        ],
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    });

    const renderInput = async ({
      value = "",
      editorState = null,
      placeholder,
      draftKey = "project-a:conversation-a",
    }: {
      value?: string;
      editorState?: string | null;
      placeholder: string;
      draftKey?: string;
    }) => {
      await act(async () => {
        root.render(
          <ChatInput
            ref={inputRef}
            draftKey={draftKey}
            value={value}
            editorState={editorState}
            placeholder={placeholder}
            agentHandles={[]}
            onChange={onChange}
            onKeyDown={onKeyDown}
          />,
        );
      });
    };

    await renderInput({ placeholder: "Ask for something..." });
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => undefined);

    await act(async () => {
      inputRef.current?.acceptGhostSuggestion("Draft survives");
    });

    const input = container.querySelector('[data-testid="chat-input"]');
    expect(input?.textContent).toBe("Draft survives");
    expect(onChange).toHaveBeenCalled();

    const [nextValue, nextEditorState] = onChange.mock.lastCall as [string, string];

    // An older controlled snapshot can land before the owner adopts the
    // Lexical change. Its stale serialized state must not roll the edit back.
    await renderInput({
      editorState: staleEmptyEditorState,
      placeholder: "Ask Octo...",
    });
    expect(input?.textContent).toBe("Draft survives");

    await renderInput({
      value: nextValue,
      editorState: nextEditorState,
      placeholder: "Ask Octo...",
    });
    expect(input?.textContent).toBe("Draft survives");

    // Once the local edit is acknowledged, a real controlled reset remains
    // authoritative.
    await renderInput({
      editorState: staleEmptyEditorState,
      placeholder: "Ask Octo...",
    });
    expect(input?.textContent).toBe("");

    await act(async () => {
      inputRef.current?.acceptGhostSuggestion("Do not leak");
    });
    expect(input?.textContent).toBe("Do not leak");

    // A project or conversation switch deliberately discards an unacknowledged
    // local draft so it cannot leak into the next chat scope.
    await renderInput({
      draftKey: "project-a:conversation-b",
      editorState: staleEmptyEditorState,
      placeholder: "Ask Octo...",
    });
    expect(input?.textContent).toBe("");
  });

  it("acknowledges whitespace drafts whose controlled editor state is normalized to null", async () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    const inputRef = createRef<ChatInputHandle>();

    const renderInput = async (value: string, editorState: string | null) => {
      await act(async () => {
        root.render(
          <ChatInput
            ref={inputRef}
            draftKey="project-a:conversation-a"
            value={value}
            editorState={editorState}
            placeholder="Ask Octo..."
            agentHandles={[]}
            onChange={onChange}
            onKeyDown={onKeyDown}
          />,
        );
      });
    };

    await renderInput("", null);

    const nodePrototype = Node.prototype as Node & {
      getBoundingClientRect?: () => DOMRect;
    };
    const originalGetBoundingClientRect = nodePrototype.getBoundingClientRect;
    nodePrototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    try {
      await act(async () => {
        inputRef.current?.acceptGhostSuggestion("  ");
      });
    } finally {
      if (originalGetBoundingClientRect) {
        nodePrototype.getBoundingClientRect = originalGetBoundingClientRect;
      } else {
        delete nodePrototype.getBoundingClientRect;
      }
    }

    const input = container.querySelector('[data-testid="chat-input"]');
    expect(input?.textContent).toBe("  ");

    // Conversation state intentionally drops the serialized Lexical state for
    // whitespace-only drafts. Matching text is therefore the acknowledgement.
    await renderInput("  ", null);
    expect(input?.textContent).toBe("  ");

    // Once acknowledged, a same-conversation programmatic draft remains
    // authoritative (CTA, voice transcript, slash command, and similar flows).
    await renderInput("Suggested next step", null);
    expect(input?.textContent).toBe("Suggested next step");
  });

  it("clips a multiline ghost suggestion to the editable input bounds", async () => {
    await act(async () => {
      root.render(
        <ChatInput
          value="A wrapped starter prompt"
          editorState={null}
          placeholder="Ask for something..."
          ghostSuggestionRemainder={"\nFirst follow-up\nSecond follow-up"}
          agentHandles={[]}
          onChange={vi.fn()}
          onKeyDown={vi.fn()}
        />,
      );
    });

    const ghost = container.querySelector('[data-testid="chat-input-ghost-suggestion"]');
    expect(ghost).not.toBeNull();
    expect(ghost?.className).toContain("bottom-0");
    expect(ghost?.className).toContain("overflow-hidden");
    expect(ghost?.className).toContain("whitespace-pre-wrap");
    // It starts on the first line: the editor's own top padding.
    for (const token of CHAT_INPUT_OVERLAY_TOP_CLASS.split(/\s+/)) {
      expect(ghost?.className.split(/\s+/)).toContain(token);
    }
  });

  it("sizes the one-row editor to the composer controls and folds the padding into its line cap", async () => {
    // The controls beside the editor are 36px on a fine pointer; the editor
    // pads (36 − 20) / 2 = 8px each side of its 20px line so one line — and
    // the last line of a wrapped draft — sits on the control centres, and
    // its placeholder starts on that first line. The pixel cap is the line
    // cap plus both paddings.
    await act(async () => {
      root.render(
        <ChatInput
          value=""
          editorState={null}
          placeholder="Ask for something..."
          agentHandles={[]}
          onChange={vi.fn()}
          onKeyDown={vi.fn()}
        />,
      );
    });

    const input = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    expect(input).not.toBeNull();
    const inputTokens = (input?.className ?? "").split(/\s+/);
    for (const token of [
      ...CHAT_INPUT_CONTROL_HEIGHT_CLASS.split(/\s+/),
      ...CHAT_INPUT_VERTICAL_PADDING_CLASS.split(/\s+/),
    ]) {
      expect(inputTokens).toContain(token);
    }
    // No second box: the old `min-h-7 py-1 sm:min-h-6 sm:py-0.5` is gone.
    expect(inputTokens.filter((token) => /^(?:sm:)?(?:py|min-h|max-h)-/.test(token))).toEqual([
      "min-h-9",
      "py-2",
    ]);
    const expectedMaxHeight = resolveChatInputMaxHeightPx({ compactViewport: false, coarsePointer: false });
    expect(expectedMaxHeight).toBe(10 * CHAT_INPUT_LINE_HEIGHT_PX + 2 * 8);
    expect(input?.getAttribute("data-max-height-px")).toBe(String(expectedMaxHeight));
    expect(input?.style.maxHeight).toBe(`${expectedMaxHeight}px`);

    // The leaf div that holds the placeholder text (its ancestors carry the
    // same textContent while the editor is empty).
    const placeholder = Array.from(container.querySelectorAll("div")).find(
      (node) => node.children.length === 0 && node.textContent === "Ask for something...",
    );
    expect(placeholder).toBeDefined();
    for (const token of CHAT_INPUT_OVERLAY_TOP_CLASS.split(/\s+/)) {
      expect(placeholder?.className.split(/\s+/)).toContain(token);
    }
  });

  it("reads the coarse-pointer padding into the cap on touch devices", async () => {
    // On a coarse pointer the controls are 44px, so the editor pads
    // (44 − 20) / 2 = 12px a side (pointer-coarse:py-3 in CSS) and the cap
    // must fold in 24px, not 16px: the JS reads the same media query the
    // Tailwind variant does.
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    const matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: query === COARSE_POINTER_MEDIA_QUERY,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
    try {
      await act(async () => {
        root.render(
          <ChatInput
            value=""
            editorState={null}
            placeholder="Ask for something..."
            agentHandles={[]}
            onChange={vi.fn()}
            onKeyDown={vi.fn()}
            compactViewport
          />,
        );
      });
      expect(matchMedia).toHaveBeenCalledWith(COARSE_POINTER_MEDIA_QUERY);
      const input = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
      const expectedMaxHeight = resolveChatInputMaxHeightPx({ compactViewport: true, coarsePointer: true });
      expect(expectedMaxHeight).toBe(6 * CHAT_INPUT_LINE_HEIGHT_PX + 2 * 12);
      expect(input?.getAttribute("data-max-height-px")).toBe(String(expectedMaxHeight));
      expect(input?.style.maxHeight).toBe(`${expectedMaxHeight}px`);
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, "matchMedia", originalMatchMedia);
      } else {
        Reflect.deleteProperty(window, "matchMedia");
      }
    }
  });
});
