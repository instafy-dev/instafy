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
    queueCanSendNow: false,
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
    onRemoveQueuedItem: vi.fn(),
    onReorderQueuedItem: vi.fn(),
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

  it("keeps the collapsed queue behind a counted task-list icon", async () => {
    const onToggleExpanded = vi.fn();
    const onEditQueuedMessage = vi.fn();

    await act(async () => {
      root.render(<ChatSendQueueSurface {...buildProps({ onToggleExpanded, onEditQueuedMessage })} />);
    });

    expect(container.textContent).not.toContain("two");
    expect(container.textContent).not.toContain("Reply in progress");
    expect(container.textContent).not.toContain("@octo");
    const summary = container.querySelector('[data-testid="chat-send-queue-agent-summary"]');
    expect(summary?.getAttribute("aria-label")).toBe("Queued messages (1): two");
    expect(summary?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(`#${summary?.getAttribute("aria-controls")}`)).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-send-queue-icon"]')).not.toBeNull();
    expect(summary?.querySelector('span[aria-hidden="true"]')?.className).toContain("bg-primary-600");
    expect(container.textContent).toBe("1");

    await act(async () => {
      (summary as HTMLButtonElement).click();
    });

    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    expect(onEditQueuedMessage).not.toHaveBeenCalled();
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

    const editButton = container.querySelector('[data-testid="chat-send-queue-steer-collapsed"]');
    expect(editButton).toBeNull();
    expect(container.textContent).toBe("2");

    await act(async () => {
      (container.querySelector('[data-testid="chat-send-queue-agent-summary"]') as HTMLButtonElement).click();
    });

    expect(onEditQueuedMessage).not.toHaveBeenCalled();
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("omits runtime status and duplicate count from the expanded list", async () => {
    await act(async () => {
      root.render(
        <ChatSendQueueSurface
          {...buildProps({
            totalQueuedCount: 2,
            chatSendQueueExpanded: true,
            collapsedQueuedMessageSummary: null,
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
    expect(
      container.querySelector('[data-testid="chat-send-queue-agent-summary"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.textContent).not.toContain("Runtime offline");
    expect(container.textContent).not.toContain("Reconnect");
    expect(container.querySelector('[data-testid="chat-send-queue-runtime-action-expanded"]')).toBeNull();
    expect(container.textContent).not.toContain("@octo");
    expect(container.querySelector('[data-testid="chat-send-queue-panel-header"]')?.textContent?.trim()).toBe(
      "Queue",
    );
    const panel = container.querySelector('[aria-label="Queued messages"][role="region"]');
    expect(panel?.className).toContain("basis-full");
    expect(panel?.firstElementChild?.className).toContain("sm:w-[min(24rem,100%)]");
  });

  it("shows queue editing without a misleading queue toggle", async () => {
    await act(async () => {
      root.render(
        <ChatSendQueueSurface
          {...buildProps({
            totalQueuedCount: 2,
            editingQueuedItem: { targetAgentHandles: ["octo"] },
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
            collapsedQueuedMessageSummary: null,
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Editing queued message");
    expect(container.querySelector('[data-testid="chat-send-queue-agent-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-send-queue-icon"]')).toBeNull();
    expect(container.querySelector('[aria-label="Queued messages"][role="region"]')).not.toBeNull();
  });

  it("bounds long queued-message previews in the trigger name", async () => {
    const message = "a".repeat(400);
    await act(async () => {
      root.render(
        <ChatSendQueueSurface
          {...buildProps({
            collapsedQueuedMessageSummary: { message },
            chatSendQueueDisplay: [
              {
                id: "queued-1",
                message,
                targetHandles: ["octo"],
              },
            ],
          })}
        />,
      );
    });

    const name = container
      .querySelector('[data-testid="chat-send-queue-agent-summary"]')
      ?.getAttribute("aria-label");
    expect(name).toBe(`Queued messages (1): ${"a".repeat(119)}…`);
    expect(name).not.toContain(message);
  });
});
