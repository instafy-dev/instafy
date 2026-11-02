// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageMenuOverlay } from "../ChatPanelOverlays";
import { formatSpeakerTimestamp } from "../chatSpeakerTimestamp";

const actionsMenu = {
  kind: "message" as const,
  messageId: "assistant-1",
  x: 20,
  y: 20,
  maxHeight: 180,
  view: "actions" as const,
};

const emptyActions = () => ({
  selectedMessageTokenUsage: null,
  onClose: vi.fn(),
  onShowActionsView: vi.fn(),
  onShowTokenUsageView: vi.fn(),
  onCopySelectedMessage: vi.fn(),
  onCopyConversation: vi.fn(),
  onCopyTokenUsage: vi.fn(),
});

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
    document.querySelector("[data-overlay-return-trigger]")?.remove();
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

    expect(document.body.textContent).toContain("Copy message");
    expect(document.body.textContent).toContain("Message stats…");
    expect(document.body.textContent).not.toContain("Input 120");
    const menu = document.querySelector<HTMLElement>("[style*='position: fixed']");
    expect(menu?.style.maxHeight).toBe("180px");
    expect(menu?.querySelector(".overflow-y-auto")).not.toBeNull();
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

    expect(document.body.textContent).toContain("Message stats");
    expect(document.body.textContent).toContain("Input 120");
    expect(document.body.textContent).toContain("Cached 30");
    expect(document.body.textContent).toContain("Output 10");
    expect(document.body.textContent).toContain("Stateless replay");
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

    expect(document.body.textContent).toContain("Reply to selection");
    expect(document.body.textContent).toContain("Summarize selection");
    expect(document.body.textContent).toContain("Explain more");

    const buttons = Array.from(document.querySelectorAll("button"));
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

    expect(document.body.textContent).not.toContain("Reply to selection");
    expect(document.body.textContent).not.toContain("Summarize selection");
    expect(document.body.textContent).not.toContain("Explain more");
  });

  it("shows the selected message's exact sent time without requiring token stats", async () => {
    const timestamp = Date.parse("2026-11-02T12:34:00Z");
    await act(async () => root.render(<ChatMessageMenuOverlay {...emptyActions()}
      messageMenu={actionsMenu} selectedMessageTimestamp={timestamp} />));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Message actions"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('[aria-hidden="true"]')).toBeNull();
    const time = dialog?.querySelector("time");
    expect(time?.dateTime).toBe(new Date(timestamp).toISOString());
    expect(time?.textContent).toBe(formatSpeakerTimestamp(timestamp)?.title);
    expect(dialog?.textContent).toContain("Sent ");
    expect(dialog?.textContent).not.toContain("Message stats…");
  });

  it.each([null, 0, NaN])("omits an unavailable sent time (%s)", async (timestamp) => {
    await act(async () => root.render(<ChatMessageMenuOverlay {...emptyActions()}
      messageMenu={actionsMenu} selectedMessageTimestamp={timestamp} />));
    expect(document.querySelector("time")).toBeNull();
    expect(document.body.textContent).not.toContain("Sent ");
  });

  it("does not show a stale selected message time in the conversation menu", async () => {
    await act(async () => root.render(<ChatMessageMenuOverlay {...emptyActions()}
      messageMenu={{ ...actionsMenu, kind: "conversation", messageId: null }}
      selectedMessageTimestamp={Date.now()} />));
    expect(document.querySelector('[role="dialog"][aria-label="Conversation actions"]')).not.toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });

  it("focuses the actions, closes on Escape and restores the invoking control", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Message actions";
    trigger.dataset.overlayReturnTrigger = "true";
    document.body.appendChild(trigger);
    trigger.focus();
    const callbacks = { ...emptyActions(), onClose };
    await act(async () => {
      root.render(<ChatMessageMenuOverlay {...callbacks} messageMenu={actionsMenu} />);
    });
    await act(async () => { await new Promise(requestAnimationFrame); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(<ChatMessageMenuOverlay {...callbacks} messageMenu={null} />);
    });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(document.activeElement).toBe(trigger);
  });
});
