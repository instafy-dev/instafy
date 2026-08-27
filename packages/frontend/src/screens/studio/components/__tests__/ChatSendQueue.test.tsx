// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSendQueue } from "../ChatSendQueue";

describe("ChatSendQueue", () => {
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
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("labels the queued-message affordance as editing", async () => {
    const onEdit = vi.fn();

    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[
            {
              id: "queued-1",
              message: "Follow up on the codec lane",
              targetHandles: ["octo"],
            },
          ]}
          onRemove={() => undefined}
          onReorder={() => undefined}
          onEdit={onEdit}
        />,
      );
    });

    const editButton = container.querySelector('[data-testid="chat-send-queue-steer"]') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    expect(editButton?.textContent?.trim()).toBe("Edit");
    expect(editButton?.getAttribute("aria-label")).toBe(
      "Edit queued message 1: Follow up on the codec lane",
    );
    expect(container.textContent).not.toContain("@octo");

    await act(async () => {
      editButton?.click();
    });

    expect(onEdit).toHaveBeenCalledWith("queued-1");
  });

  it("surfaces failed entry errors visibly and as a tooltip", async () => {
    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[
            {
              id: "queued-1",
              message: "Follow up on the codec lane",
              targetHandles: ["octo"],
              errorMessage: "runtime offline",
            },
          ]}
          onRemove={() => undefined}
          onReorder={() => undefined}
        />,
      );
    });

    const messageSpan = container.querySelector('[title="runtime offline"]');
    expect(messageSpan).not.toBeNull();
    expect(messageSpan?.textContent).toContain("Follow up on the codec lane");
    expect(messageSpan?.textContent).toContain("runtime offline");
  });

  it("disables editing while queued message editing is unavailable", async () => {
    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[
            {
              id: "queued-1",
              message: "Follow up on the codec lane",
              targetHandles: [],
            },
          ]}
          onRemove={() => undefined}
          onReorder={() => undefined}
          onEdit={() => undefined}
          editDisabled
        />,
      );
    });

    const steerButton = container.querySelector('[data-testid="chat-send-queue-steer"]') as HTMLButtonElement | null;
    expect(steerButton?.disabled).toBe(true);
  });

  it("bounds long messages in every row action name", async () => {
    const message = "a".repeat(400);
    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[{ id: "queued-1", message, targetHandles: ["octo"] }]}
          onRemove={() => undefined}
          onReorder={() => undefined}
          onEdit={() => undefined}
          onSendNow={() => undefined}
        />,
      );
    });

    const preview = `${"a".repeat(119)}…`;
    expect(
      container.querySelector('[data-testid="chat-send-queue-send-now"]')?.getAttribute("aria-label"),
    ).toBe(`Send queued message 1 now: ${preview}`);
    expect(
      container.querySelector('[data-testid="chat-send-queue-steer"]')?.getAttribute("aria-label"),
    ).toBe(`Edit queued message 1: ${preview}`);
    expect(
      container.querySelector('[data-testid="chat-send-queue-remove"]')?.getAttribute("aria-label"),
    ).toBe(`Remove queued message 1: ${preview}`);
  });

  it("shows a dedicated, bounded drag handle only when reordering is useful", async () => {
    const longMessage = "a".repeat(400);
    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[
            { id: "queued-1", message: longMessage, targetHandles: ["octo"] },
            { id: "queued-2", message: "Second message", targetHandles: ["octo"] },
          ]}
          onRemove={() => undefined}
          onReorder={() => undefined}
        />,
      );
    });

    const handles = container.querySelectorAll('[data-testid="chat-send-queue-reorder"]');
    expect(handles).toHaveLength(2);
    expect(handles[0]?.getAttribute("aria-label")).toBe(
      `Reorder queued message 1 of 2: ${"a".repeat(119)}…`,
    );
    expect(handles[0]?.className).toContain("touch-none");

    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[{ id: "queued-1", message: longMessage, targetHandles: ["octo"] }]}
          onRemove={() => undefined}
          onReorder={() => undefined}
        />,
      );
    });
    expect(container.querySelector('[data-testid="chat-send-queue-reorder"]')).toBeNull();
  });

  it("moves the focused row once with the keyboard drag contract", async () => {
    const onReorder = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="chat-send-queue-item"]'),
      );
      const row = this.matches('[data-testid="chat-send-queue-item"]')
        ? this
        : this.closest<HTMLElement>('[data-testid="chat-send-queue-item"]');
      const index = row ? Math.max(0, rows.indexOf(row)) : 0;
      return {
        x: 0,
        y: index * 48,
        top: index * 48,
        left: 0,
        right: 320,
        bottom: index * 48 + 40,
        width: 320,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    });
    await act(async () => {
      root.render(
        <ChatSendQueue
          items={[
            { id: "queued-1", message: "First message", targetHandles: ["octo"] },
            { id: "queued-2", message: "Second message", targetHandles: ["octo"] },
          ]}
          onRemove={() => undefined}
          onReorder={onReorder}
        />,
      );
    });

    const handles = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-send-queue-reorder"]',
    );
    const secondHandle = handles[1];
    await act(async () => {
      secondHandle.focus();
    });

    const press = async (key: string, code: string) => {
      await act(async () => {
        secondHandle.dispatchEvent(
          new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };
    await press("Enter", "Enter");
    expect(secondHandle.getAttribute("aria-pressed")).toBe("true");
    const dragOverlay = document.body.querySelector<HTMLElement>(
      '[data-testid="chat-send-queue-drag-overlay"]',
    );
    expect(dragOverlay).not.toBeNull();
    expect(container.contains(dragOverlay)).toBe(false);
    expect(dragOverlay?.parentElement?.style.zIndex).toBe("100001");
    await press("ArrowUp", "ArrowUp");
    expect(document.body.textContent).toContain("position 1 of 2");
    await press("Enter", "Enter");
    expect(document.body.textContent).toContain("moved to position 1 of 2");

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("queued-2", 0);
    expect(document.activeElement).toBe(secondHandle);
  });
});
