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

  it("restores the latest private draft from the collapsed tray", async () => {
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

    expect(container.textContent).toContain("Drafts (2)");
    await act(async () => {
      (container.querySelector('[data-testid="chat-message-stash-restore-latest"]') as HTMLButtonElement).click();
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
      (container.querySelector('[data-testid="chat-message-stashes-toggle"]') as HTMLButtonElement).click();
    });

    expect(container.textContent).toContain("Restored in composer");
    await act(async () => {
      (container.querySelector('[data-testid="chat-message-stash-delete"]') as HTMLButtonElement).click();
    });
    expect(onDelete).toHaveBeenCalledWith("stash-1");
  });
});
