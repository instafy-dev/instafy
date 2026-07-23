// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput, type ChatInputHandle } from "../chat-input/ChatInput";

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
  });
});
