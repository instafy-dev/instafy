// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageStashTray } from "../ChatMessageStashTray";
import type { ControllerMessageStash } from "../../../../services/runtimeController/messageStashes";

const stash: ControllerMessageStash = {
  id: "stash-1",
  clientStashId: "client-stash-1",
  projectId: "project-1",
  conversationId: "conversation-1",
  text: "Try the smaller type scale",
  editorState: { root: { children: [] } },
  composerEnvelope: { targetAgentHandles: ["octo"] },
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
};

describe("ChatMessageStashTray", () => {
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

  it("keeps stashed drafts behind a counted icon and restores the latest after expanding", async () => {
    const onRestore = vi.fn();
    const older = { ...stash, id: "stash-older", text: "Older draft" };
    await act(async () => {
      root.render(
        <ChatMessageStashTray
          stashes={[stash, older]}
          restoredStashId={null}
          onRestore={onRestore}
          onDelete={vi.fn()}
        />,
      );
    });

    const summary = container.querySelector('[data-testid="chat-message-stashes-summary"]');
    expect(summary?.getAttribute("aria-label")).toBe("Stashed drafts (2)");
    expect(summary?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(`#${summary?.getAttribute("aria-controls")}`)).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-message-stashes-icon"]')).not.toBeNull();
    expect(summary?.querySelector('span[aria-hidden="true"]')?.className).toContain("bg-slate-600");
    expect(container.textContent).toBe("2");
    await act(async () => {
      (summary as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="chat-message-stashes-summary"]')).toBe(summary);
    expect(summary?.getAttribute("aria-expanded")).toBe("true");
    const panel = container.querySelector('[aria-label="Stashed drafts"][role="region"]');
    expect(panel?.className).toContain("basis-full");
    expect(panel?.firstElementChild?.className).toContain("sm:w-[min(24rem,100%)]");
    await act(async () => {
      (container.querySelector('[data-testid="chat-message-stash-restore"]') as HTMLButtonElement).click();
    });
    expect(onRestore).toHaveBeenCalledWith(stash);
  });

  it("keeps restore and explicit delete as separate expanded actions", async () => {
    const onDelete = vi.fn();
    await act(async () => {
      root.render(
        <ChatMessageStashTray
          stashes={[stash]}
          restoredStashId="stash-1"
          onRestore={vi.fn()}
          onDelete={onDelete}
        />,
      );
    });
    await act(async () => {
      (container.querySelector('[data-testid="chat-message-stashes-summary"]') as HTMLButtonElement).click();
    });

    expect(container.textContent).toContain("Restored in composer");
    expect(
      container.querySelector('[data-testid="chat-message-stashes-summary"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="chat-message-stash-delete"]')?.getAttribute("aria-label"),
    ).toContain("Try the smaller type scale");
    await act(async () => {
      (container.querySelector('[data-testid="chat-message-stash-delete"]') as HTMLButtonElement).click();
    });
    expect(onDelete).toHaveBeenCalledWith("stash-1");
    expect(
      container.querySelector('[data-testid="chat-message-stashes-summary"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("bounds long draft previews in restore and delete names", async () => {
    const text = "a".repeat(400);
    await act(async () => {
      root.render(
        <ChatMessageStashTray
          stashes={[{ ...stash, text }]}
          restoredStashId={null}
          expanded
          onRestore={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    const restoreName = container
      .querySelector('[data-testid="chat-message-stash-restore"]')
      ?.getAttribute("aria-label");
    const deleteName = container
      .querySelector('[data-testid="chat-message-stash-delete"]')
      ?.getAttribute("aria-label");
    expect(restoreName).toBe(`Restore stashed draft 1: ${"a".repeat(119)}…`);
    expect(deleteName).toBe(`Delete stashed draft 1: ${"a".repeat(119)}…`);
    expect(restoreName).not.toContain(text);
    expect(deleteName).not.toContain(text);
  });
});
