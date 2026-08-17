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
          onMove={() => undefined}
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
          onMove={() => undefined}
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
          onMove={() => undefined}
          onEdit={() => undefined}
          editDisabled
        />,
      );
    });

    const steerButton = container.querySelector('[data-testid="chat-send-queue-steer"]') as HTMLButtonElement | null;
    expect(steerButton?.disabled).toBe(true);
  });
});
