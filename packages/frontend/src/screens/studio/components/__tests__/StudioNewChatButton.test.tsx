// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioNewChatButton } from "../StudioNewChatButton";

const mocks = vi.hoisted(() => ({
  publicChat: vi.fn(),
  privateChat: vi.fn(),
  allowed: true,
}));

vi.mock("../../workspaceControls", () => ({
  useWorkspaceControls: () => ({
    onStartNewConversation: mocks.publicChat,
    onStartPrivateConversation: mocks.privateChat,
    showChatActions: mocks.allowed,
  }),
}));

describe("StudioNewChatButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.allowed = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function click(testId: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  it("makes a chat at once, with no Public or Private choice in between", async () => {
    const onStarted = vi.fn();
    await act(async () => root.render(<StudioNewChatButton testId="sidebar-new-chat" label="New chat" onStarted={onStarted} />));
    await click("sidebar-new-chat");
    expect(mocks.publicChat).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(mocks.privateChat).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Public chat");
    expect(document.body.textContent).not.toContain("Private chat");
    expect(container.querySelector("[aria-haspopup], [aria-expanded]")).toBeNull();
  });

  it("starts the chat only once a navigation owner runs it", async () => {
    let pending: (() => void) | null = null;
    const runAction = vi.fn((action: () => void) => { pending = action; });
    await act(async () => root.render(<StudioNewChatButton runAction={runAction} />));
    await click("topbar-new-conversation");
    expect(runAction).toHaveBeenCalledOnce();
    expect(mocks.publicChat).not.toHaveBeenCalled();
    await act(async () => pending!());
    expect(mocks.publicChat).toHaveBeenCalledOnce();
  });

  it("does not offer chat creation when access is blocked", async () => {
    mocks.allowed = false;
    await act(async () => root.render(<StudioNewChatButton />));
    expect(container.querySelector("button")).toBeNull();
  });
});
