// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../../conversations/conversationState";
import { ConversationHistoryTab, type ConversationHistoryTabProps } from "../ConversationHistoryTab";

const mocks = vi.hoisted(() => ({
  conversations: [] as ConversationState[],
  activeConversationId: "a" as string | null,
  setConversationLifecycleStatus: vi.fn(),
  setConversationTitle: vi.fn(),
  closeTab: vi.fn(),
  keepTabOpen: vi.fn(),
  preview: false,
  openConversationTab: vi.fn(),
  requestUrlPush: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ ...mocks, remoteConversationHistoryResolved: true }),
}));
vi.mock("../WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    ...mocks,
    tabs: [{ id: "tab-a", kind: "conversation", conversationId: "a", preview: mocks.preview }],
  }),
}));
vi.mock("../../status/useStatus", () => ({ useStatus: () => mocks }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { conversations: { updateMetadata: vi.fn() } } }));

function conversation(id: string, overrides: Partial<ConversationState> = {}): ConversationState {
  return { ...createInitialConversation({ localId: id }), title: `Chat ${id}`, ...overrides };
}

describe("ConversationHistoryTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let viewportWidth: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    viewportWidth = 1280;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: viewportWidth >= Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    mocks.conversations = [conversation("a"), conversation("b")];
    mocks.activeConversationId = "a";
    mocks.preview = false;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: ConversationHistoryTabProps = {}) {
    await act(async () => root.render(<ConversationHistoryTab {...props} />));
  }

  async function click(selector: string) {
    const element = document.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => element?.click());
  }

  async function search(value: string) {
    const input = container.querySelector<HTMLInputElement>('[data-testid="conversation-history-search"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function selectFilter(status: string) {
    await click('[data-testid="conversation-history-filter"]');
    await click(`[role="menuitemradio"][data-key="${status}"]`);
  }

  it.each([320, 800, 900, 1280])("provides search immediately at %ipx and filters the chat list", async (width) => {
    viewportWidth = width;
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("All chats");
    expect(container.querySelector('[data-testid="conversation-history-search-toggle"]')).toBeNull();
    await search("Chat b");
    const rows = container.querySelectorAll('[data-testid="conversation-history-item"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("Chat b");
    await search("");
    expect(container.querySelectorAll('[data-testid="conversation-history-item"]')).toHaveLength(2);
  });

  it.each([899, 900])("opens chats as previews and closes only below the shared desktop breakpoint (%ipx)", async (width) => {
    viewportWidth = width;
    const onRequestClose = vi.fn();
    await render({ onRequestClose });
    await click('[data-testid="conversation-history-item"]:not([aria-current])');
    expect(mocks.requestUrlPush).toHaveBeenCalledTimes(1);
    expect(mocks.openConversationTab).toHaveBeenCalledWith("b", { preview: true });
    expect(onRequestClose).toHaveBeenCalledTimes(width < 900 ? 1 : 0);
  });

  it.each([800, 1280])("keeps New chat accessible, clears filters, and closes only the narrow drawer (%ipx)", async (width) => {
    viewportWidth = width;
    const onStartNewConversation = vi.fn();
    const onRequestClose = vi.fn();
    await render({ onStartNewConversation, onRequestClose });
    const newChat = container.querySelector('[data-testid="conversation-history-new-chat"]');
    expect(newChat?.getAttribute("aria-label")).toBe("New chat");
    expect(newChat?.getAttribute("title")).toBe("New chat");
    await search("Older chat");
    await selectFilter("archived");
    await click('[data-testid="conversation-history-new-chat"]');
    expect(onStartNewConversation).toHaveBeenCalledTimes(1);
    expect(onRequestClose).toHaveBeenCalledTimes(width < 900 ? 1 : 0);
    expect(container.querySelector<HTMLInputElement>('[data-testid="conversation-history-search"]')?.value).toBe("");
    expect(container.querySelector("h2")?.textContent).toBe("All chats");
    expect(container.querySelector('[data-testid="conversation-history-filter"]')?.getAttribute("aria-label")).toBe("Filter chats: Active");
    expect(container.querySelector('[data-testid="conversation-history-filter-indicator"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="conversation-history-item"]')).toHaveLength(2);
  });

  it("shows status counts and selection, dismissing the menu without clearing the search", async () => {
    mocks.conversations = [
      conversation("a"),
      conversation("b"),
      conversation("archived-match", { lifecycleStatus: "archived" }),
      conversation("archived-other", { lifecycleStatus: "archived" }),
      conversation("hidden", { lifecycleStatus: "hidden" }),
      conversation("deleted", { lifecycleStatus: "deleted" }),
    ];
    await render();
    await search("archived-match");
    await click('[data-testid="conversation-history-filter"]');

    const menu = document.querySelector('[role="menu"][aria-label="Chat status"]');
    expect(menu).not.toBeNull();
    const options = Array.from(menu?.querySelectorAll('[role="menuitemradio"]') ?? []);
    expect(options.map((option) => option.textContent)).toEqual([
      "Active (2)", "Archived (2)", "Hidden (1)", "Trash (1)",
    ]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "true", "false", "false", "false",
    ]);

    await click('[role="menuitemradio"][data-key="archived"]');
    expect(document.querySelector('[role="menu"][aria-label="Chat status"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-testid="conversation-history-search"]')?.value).toBe("archived-match");
    expect(container.querySelectorAll('[data-testid="conversation-history-item"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="conversation-history-item"]')?.textContent).toBe("Chat archived-match");
    await click('[data-testid="conversation-history-filter"]');
    expect(document.querySelector('[role="menuitemradio"][data-key="archived"]')?.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[role="menuitemradio"][data-key="active"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it.each([
    ["archived", "Archived", "Archived chats"],
    ["hidden", "Hidden", "Hidden chats"],
    ["deleted", "Trash", "Trash"],
  ])("makes the %s filter visible and clears its indication when returning to active chats", async (status, label, title) => {
    await render();
    expect(container.querySelector('[data-testid="conversation-history-filter-indicator"]')).toBeNull();
    await selectFilter(status);
    expect(container.querySelector("h2")?.textContent).toBe(title);
    expect(container.querySelector('[data-testid="conversation-history-filter"]')?.getAttribute("aria-label")).toBe(`Filter chats: ${label}`);
    expect(container.querySelector('[data-testid="conversation-history-filter-indicator"]')).not.toBeNull();
    await selectFilter("active");
    expect(container.querySelector("h2")?.textContent).toBe("All chats");
    expect(container.querySelector('[data-testid="conversation-history-filter"]')?.getAttribute("aria-label")).toBe("Filter chats: Active");
    expect(container.querySelector('[data-testid="conversation-history-filter-indicator"]')).toBeNull();
  });

  it("returns focus to the filter on Escape without closing the drawer", async () => {
    const onRequestClose = vi.fn();
    await render({ onRequestClose });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="conversation-history-filter"]');
    await act(async () => trigger?.focus());
    await click('[data-testid="conversation-history-filter"]');
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Chat status"]');
    expect(menu).not.toBeNull();
    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(document.querySelector('[role="menu"][aria-label="Chat status"]')).toBeNull();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes an open tab from its single row menu without selecting or changing the chat", async () => {
    await render();
    await click('[data-testid="conversation-history-menu-a"]');
    expect(document.querySelector('[data-testid="conversation-history-menu-keep-open"]')).toBeNull();
    await click('[data-testid="conversation-history-menu-close-tab"]');
    expect(mocks.closeTab).toHaveBeenCalledWith("tab-a");
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
    expect(mocks.setConversationLifecycleStatus).not.toHaveBeenCalled();
  });

  it.each([800, 1280])("keeps a preview open from its row menu without navigating (%ipx)", async (width) => {
    viewportWidth = width;
    mocks.preview = true;
    const onRequestClose = vi.fn();
    await render({ onRequestClose });
    await click('[data-testid="conversation-history-menu-a"]');
    await click('[data-testid="conversation-history-menu-keep-open"]');
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("tab-a");
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
    expect(mocks.requestUrlPush).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("dismisses history without changing its underlying conversation", async () => {
    const onRequestClose = vi.fn();
    await render({ onRequestClose });
    await click('[data-testid="conversation-history-close"]');
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("keeps search results nested under matching parents and status filters usable", async () => {
    mocks.activeConversationId = null;
    mocks.conversations = [
      conversation("a", { controllerId: "remote-a" }),
      conversation("child", { parentConversationId: "remote-a" }),
      conversation("archived", { lifecycleStatus: "archived" }),
    ];
    await render();
    expect(container.querySelectorAll('[data-testid="conversation-history-item"]')).toHaveLength(1);
    await search("child");
    expect(container.querySelectorAll('[data-testid="conversation-history-item"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="conversation-history-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    await search("");
    await click('[data-testid="conversation-history-filter"]');
    await click('[role="menuitemradio"][data-key="archived"]');
    expect(container.querySelectorAll('[data-testid="conversation-history-item"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="conversation-history-item"]')?.textContent).toBe("Chat archived");
  });
});
