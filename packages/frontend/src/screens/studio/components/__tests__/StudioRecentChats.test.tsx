// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../../../../conversations/conversationState";
import { StudioRecentChats, type StudioRecentChatsProps } from "../StudioRecentChats";

function makeConversation(id: string, overrides: Partial<ConversationState> = {}): ConversationState {
  return { ...createInitialConversation({ localId: id }), title: `Chat ${id}`, ...overrides };
}

function Harness(props: Partial<StudioRecentChatsProps>) {
  const [expanded, setExpanded] = useState(true);
  return (
    <StudioRecentChats
      conversations={[makeConversation("a"), makeConversation("b")]}
      collapsed={false}
      expanded={expanded}
      onExpandedChange={setExpanded}
      onSelectConversation={vi.fn()}
      onBrowseAll={vi.fn()}
      active
      rowClassName=""
      iconClassName=""
      {...props}
    />
  );
}

describe("StudioRecentChats", () => {
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

  async function render(props: Partial<StudioRecentChatsProps> = {}) {
    await act(async () => root.render(<Harness {...props} />));
  }

  async function click(testId: string) {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  it("shows up to six chats in caller order and keeps Browse all available", async () => {
    const conversations = Array.from({ length: 8 }, (_, i) => makeConversation(`${i}`));
    const onSelectConversation = vi.fn();
    const onBrowseAll = vi.fn();
    await render({ conversations, onSelectConversation, onBrowseAll });

    expect(container.querySelectorAll('[data-testid^="sidebar-recent-chat-"]')).toHaveLength(6);
    expect(container.querySelector('[data-testid="sidebar-recent-chat-6"]')).toBeNull();
    await click("sidebar-recent-chat-4");
    expect(onSelectConversation).toHaveBeenCalledWith("4");
    await click("sidebar-browse-all-chats");
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
  });

  it("lets the Chats label collapse and expand the list without navigating", async () => {
    const onSelectConversation = vi.fn();
    await render({ onSelectConversation });
    expect(container.querySelector('[data-testid="sidebar-nav-history"]')?.getAttribute("aria-expanded")).toBe("true");
    await click("sidebar-nav-history");
    expect(container.querySelector('[data-testid="sidebar-recent-chats-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-nav-history"]')?.getAttribute("aria-expanded")).toBe("false");
    await click("sidebar-nav-history");
    expect(container.querySelector('[data-testid="sidebar-recent-chat-a"]')).not.toBeNull();
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  it("opens the collapsed rail's recent list immediately and closes it after selection", async () => {
    const onSelectConversation = vi.fn();
    await render({ collapsed: true, onSelectConversation });
    expect(document.querySelector('[data-testid="sidebar-recent-chat-b"]')).toBeNull();
    await click("sidebar-nav-history");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Chats");
    await click("sidebar-recent-chat-b");
    expect(onSelectConversation).toHaveBeenCalledWith("b");
    expect(document.querySelector('[data-testid="sidebar-recent-chats-popover"]')).toBeNull();
  });

  it("allows Escape to dismiss the collapsed rail panel", async () => {
    await render({ collapsed: true });
    await click("sidebar-nav-history");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="sidebar-recent-chats-popover"]')).toBeNull();
  });

  it("marks Browse all as the current destination and dismisses the rail panel after opening it", async () => {
    const onBrowseAll = vi.fn();
    await render({ collapsed: true, isHistoryActive: true, onBrowseAll });
    await click("sidebar-nav-history");
    expect(document.querySelector('[data-testid="sidebar-browse-all-chats"]')?.getAttribute("aria-current")).toBe("page");
    await click("sidebar-browse-all-chats");
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="sidebar-recent-chats-popover"]')).toBeNull();
  });

  it("exposes selected, draft, unread, queued, running and open-tab states without duplicate lists", async () => {
    await render({
      conversations: [
        makeConversation("active", { draft: "unfinished message" }),
        makeConversation("unread", { unreadCount: 3 }),
        makeConversation("running", { pendingRunIds: ["run-1", "run-waiting"], awaitingLeaseRunIds: ["run-waiting"] }),
        makeConversation("queued", { pendingRunIds: ["run-2"], awaitingLeaseRunIds: ["run-2"] }),
        makeConversation("open"),
      ],
      activeConversationId: "active",
      openConversationIds: new Set(["active", "open"]),
    });
    const active = container.querySelector('[data-testid="sidebar-recent-chat-active"]');
    expect(active?.getAttribute("aria-current")).toBe("page");
    expect(active?.getAttribute("aria-label")).toContain("Draft, Open in tab");
    expect(active?.textContent).not.toContain("Draft");
    expect(active?.querySelector('[title="Draft"] svg')).not.toBeNull();
    expect(active?.getAttribute("title")).toContain("Draft");
    expect(container.querySelector('[data-testid="sidebar-recent-chat-unread"]')?.getAttribute("aria-label")).toContain("3 unread");
    expect(container.querySelector('[data-testid="sidebar-recent-chat-running"]')?.textContent).toContain("Running");
    expect(container.querySelector('[data-testid="sidebar-recent-chat-queued"]')?.textContent).toContain("Queued");
    expect(container.querySelector('[data-testid="sidebar-recent-chat-open"]')?.getAttribute("aria-label")).toContain("Open in tab");
    expect(container.querySelector('[data-testid="sidebar-recent-chat-open"] [title="Open in tab"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-chat-open"]')?.textContent).toBe("Chat open");
    expect(container.querySelectorAll('ul[aria-label="Recent chats"]')).toHaveLength(1);
  });

  it("keeps full long titles accessible", async () => {
    const title = "Investigate shared browser reload and recover the previous conversation draft ".repeat(3);
    await render({ conversations: [makeConversation("long", { title })] });
    const row = container.querySelector('[data-testid="sidebar-recent-chat-long"]');
    expect(row?.getAttribute("title")).toBe(title.trim());
    expect(row?.getAttribute("aria-label")).toBe(title.trim());
  });

  it("offers history in an empty space without adding a new-chat action", async () => {
    await render({ conversations: [] });
    expect(container.textContent).toContain("No recent chats in this space.");
    expect(container.textContent).not.toContain("New chat");
    expect(container.querySelector('[data-testid="sidebar-browse-all-chats"]')).not.toBeNull();
  });
});
