// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageMenuOverlay } from "../ChatPanelOverlays";

describe("ChatPanelOverlays", () => {
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
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps message stats behind the message action menu", async () => {
    await act(async () => {
      root.render(
        <ChatMessageMenuOverlay
          messageMenu={{
            kind: "message",
            messageId: "assistant-1",
            x: 20,
            y: 20,
            maxHeight: 180,
            view: "actions",
          }}
          selectedMessageTokenUsage={{
            inputTokens: 120,
            cachedInputTokens: 30,
            outputTokens: 10,
            context: null,
          }}
          onClose={vi.fn()}
          onShowActionsView={vi.fn()}
          onShowTokenUsageView={vi.fn()}
          onCopySelectedMessage={vi.fn()}
          onCopyConversation={vi.fn()}
          onCopyTokenUsage={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Copy message");
    expect(container.textContent).toContain("Message stats…");
    expect(container.textContent).not.toContain("Input 120");
    const menu = container.querySelector<HTMLElement>("[style*='position: fixed']");
    expect(menu?.style.maxHeight).toBe("180px");
    expect(menu?.className).toContain("overflow-y-auto");
  });

  it("shows token counts only inside the message stats view", async () => {
    await act(async () => {
      root.render(
        <ChatMessageMenuOverlay
          messageMenu={{
            kind: "message",
            messageId: "assistant-1",
            x: 20,
            y: 20,
            maxHeight: 180,
            view: "token_usage",
          }}
          selectedMessageTokenUsage={{
            inputTokens: 120,
            cachedInputTokens: 30,
            outputTokens: 10,
            context: {
              mode: "stateless_full",
              estimatedPromptTokens: 900,
              estimatedPromptUsagePercent: 8,
              estimatedHistoryTokens: null,
              modelContextWindow: null,
              totalTurns: null,
              includedTurns: null,
              summarizedTurns: null,
              omittedTurns: null,
            },
          }}
          onClose={vi.fn()}
          onShowActionsView={vi.fn()}
          onShowTokenUsageView={vi.fn()}
          onCopySelectedMessage={vi.fn()}
          onCopyConversation={vi.fn()}
          onCopyTokenUsage={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Message stats");
    expect(container.textContent).toContain("Input 120");
    expect(container.textContent).toContain("Cached 30");
    expect(container.textContent).toContain("Output 10");
    expect(container.textContent).toContain("Stateless replay");
  });

  it("shows selected-text actions only when message text is selected", async () => {
    const onReplyToSelection = vi.fn();
    const onSummarizeSelection = vi.fn();
    const onExplainSelection = vi.fn();

    await act(async () => {
      root.render(
        <ChatMessageMenuOverlay
          messageMenu={{
            kind: "message",
            messageId: "assistant-1",
            x: 20,
            y: 20,
            maxHeight: 180,
            view: "actions",
          }}
          selectedMessageTokenUsage={null}
          selectedTextAvailable
          onClose={vi.fn()}
          onShowActionsView={vi.fn()}
          onShowTokenUsageView={vi.fn()}
          onCopySelectedMessage={vi.fn()}
          onCopyConversation={vi.fn()}
          onCopyTokenUsage={vi.fn()}
          onReplyToSelection={onReplyToSelection}
          onSummarizeSelection={onSummarizeSelection}
          onExplainSelection={onExplainSelection}
        />,
      );
    });

    expect(container.textContent).toContain("Reply to selection");
    expect(container.textContent).toContain("Summarize selection");
    expect(container.textContent).toContain("Explain more");

    const buttons = Array.from(container.querySelectorAll("button"));
    await act(async () => {
      buttons.find((button) => button.textContent === "Reply to selection")?.click();
      buttons.find((button) => button.textContent === "Summarize selection")?.click();
      buttons.find((button) => button.textContent === "Explain more")?.click();
    });

    expect(onReplyToSelection).toHaveBeenCalledTimes(1);
    expect(onSummarizeSelection).toHaveBeenCalledTimes(1);
    expect(onExplainSelection).toHaveBeenCalledTimes(1);
  });

  it("keeps selected-text actions hidden for normal message menus", async () => {
    await act(async () => {
      root.render(
        <ChatMessageMenuOverlay
          messageMenu={{
            kind: "message",
            messageId: "assistant-1",
            x: 20,
            y: 20,
            maxHeight: 180,
            view: "actions",
          }}
          selectedMessageTokenUsage={null}
          onClose={vi.fn()}
          onShowActionsView={vi.fn()}
          onShowTokenUsageView={vi.fn()}
          onCopySelectedMessage={vi.fn()}
          onCopyConversation={vi.fn()}
          onCopyTokenUsage={vi.fn()}
        />,
      );
    });

    expect(container.textContent).not.toContain("Reply to selection");
    expect(container.textContent).not.toContain("Summarize selection");
    expect(container.textContent).not.toContain("Explain more");
  });
});
