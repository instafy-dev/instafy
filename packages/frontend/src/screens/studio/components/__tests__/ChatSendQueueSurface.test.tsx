// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSendQueueSurface } from "../ChatSendQueueSurface";

type SurfaceProps = Parameters<typeof ChatSendQueueSurface>[0];

function buildProps(overrides: Partial<SurfaceProps> = {}): SurfaceProps {
  return {
    totalQueuedCount: 1,
    editingQueuedItem: null,
    chatSendQueueExpanded: false,
    collapsedQueuedMessageSummary: {
      message: "two",
    },
    queueQuickSendItemId: "queued-1",
    queueCanSendNow: false,
    queueStatusLabel: "Reply in progress",
    queueStatusAction: null,
    chatSendQueueDisplay: [
      {
        id: "queued-1",
        message: "two",
        targetHandles: ["octo"],
      },
    ],
    sendingAttachment: false,
    inputValue: "",
    onToggleExpanded: vi.fn(),
    onSendQueuedMessageNow: vi.fn(),
    onRequestRuntimeRecovery: vi.fn(),
    onRemoveQueuedItem: vi.fn(),
    onMoveQueuedItem: vi.fn(),
    onEditQueuedMessage: vi.fn(),
    onCancelQueuedEdit: vi.fn(),
    onRequeueEditedMessage: vi.fn(),
    onSendEditedMessageNow: vi.fn(),
    ...overrides,
  };
}

describe("ChatSendQueueSurface", () => {
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

  it("keeps the collapsed queue focused on the message and edit action", async () => {
    const onEditQueuedMessage = vi.fn();

    await act(async () => {
      root.render(<ChatSendQueueSurface {...buildProps({ onEditQueuedMessage })} />);
    });

    expect(container.textContent).toContain("two");
    expect(container.textContent).not.toContain("Queued message");
    expect(container.textContent).not.toContain("Reply in progress");
    expect(container.textContent).not.toContain("@octo");
    expect(container.querySelector('[data-testid="chat-send-queue-agent-summary"]')?.textContent).toBe("two");

    const editButton = container.querySelector(
      '[data-testid="chat-send-queue-steer-collapsed"]',
    ) as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    expect(editButton?.textContent?.trim()).toBe("Edit");

    await act(async () => {
      editButton?.click();
    });

    expect(onEditQueuedMessage).toHaveBeenCalledWith("queued-1");
  });

  it("opens the queued list when editing a collapsed multi-message queue", async () => {
    const onToggleExpanded = vi.fn();
    const onEditQueuedMessage = vi.fn();

    await act(async () => {
      root.render(
        <ChatSendQueueSurface
          {...buildProps({
            totalQueuedCount: 2,
            collapsedQueuedMessageSummary: null,
            queueQuickSendItemId: null,
            chatSendQueueDisplay: [
              {
                id: "queued-1",
                message: "one",
                targetHandles: ["octo"],
              },
              {
                id: "queued-2",
                message: "two",
                targetHandles: ["octo"],
              },
            ],
            onToggleExpanded,
            onEditQueuedMessage,
          })}
        />,
      );
    });

    const editButton = container.querySelector(
      '[data-testid="chat-send-queue-steer-collapsed"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      editButton?.click();
    });

    expect(onEditQueuedMessage).not.toHaveBeenCalled();
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("hides passive queue status text in the expanded list", async () => {
    await act(async () => {
      root.render(
        <ChatSendQueueSurface
          {...buildProps({
            totalQueuedCount: 2,
            chatSendQueueExpanded: true,
            collapsedQueuedMessageSummary: null,
            queueStatusLabel: "Reply in progress",
            queueStatusAction: null,
            chatSendQueueDisplay: [
              {
                id: "queued-1",
                message: "how",
                targetHandles: ["octo"],
              },
              {
                id: "queued-2",
                message: "are",
                targetHandles: ["octo"],
              },
            ],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("how");
    expect(container.textContent).toContain("are");
    expect(container.textContent).not.toContain("Reply in progress");
    expect(container.textContent).not.toContain("@octo");
  });
});
