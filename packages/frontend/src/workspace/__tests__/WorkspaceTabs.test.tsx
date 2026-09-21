// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../WorkspaceTabs";

const mocks = vi.hoisted(() => ({
  preview: true,
  kind: "conversation",
  keepTabOpen: vi.fn(),
  focusTab: vi.fn(),
  closeTab: vi.fn(),
}));

vi.mock("../WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    tabs: [
      { id: "chat-a", kind: mocks.kind, panel: "settings", fileId: "file-a", conversationId: "a", title: "Design review", preview: mocks.preview, dirty: false, closable: true },
      { id: "home", kind: "panel", panel: "home", title: "Home", dirty: false, closable: true },
    ],
    activeTabId: "chat-a",
    focusTab: mocks.focusTab,
    closeTab: mocks.closeTab,
    keepTabOpen: mocks.keepTabOpen,
    moveTab: vi.fn(),
    openConversationTab: vi.fn(),
    requestUrlPush: vi.fn(),
  }),
}));
vi.mock("../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: [{ localId: "a", title: "Design review", visibility: "private", lifecycleStatus: "active" }],
    createConversation: vi.fn(),
    setConversationControllerId: vi.fn(),
    setConversationTitle: vi.fn(),
    setConversationLifecycleStatus: vi.fn(),
  }),
}));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "project-1" }) }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../useWorkspace", () => ({ useWorkspaceUi: () => ({ requestConversationInvite: vi.fn() }) }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { conversations: {} } }));
vi.mock("../../lib/desktopShell", () => ({ desktopTitleBarFree: () => false }));
vi.mock("../../components/tabs/HorizontalTabStrip", () => ({
  HorizontalTabStrip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), setActivatorNodeRef: vi.fn(), transform: null, isDragging: false }),
  horizontalListSortingStrategy: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
}));

describe("Workspace conversation preview tab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    mocks.preview = true;
    mocks.kind = "conversation";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<WorkspaceTabs />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const tabTrigger = () => document.querySelector<HTMLElement>('[data-workspace-tab-trigger="chat-a"]')!;

  async function openKeyboardMenu(key = "F10", shiftKey = true) {
    tabTrigger().focus();
    await act(async () => tabTrigger().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
    return document.querySelector<HTMLElement>('[data-testid="conversation-tab-menu"]')!;
  }

  it("distinguishes a preview visually and accessibly, and only keeps it after a double click", async () => {
    expect(tabTrigger().title).toContain("Preview");
    expect(tabTrigger().title).toContain("double-click to keep open");
    expect(tabTrigger().getAttribute("aria-label")).toBe("Design review, preview tab");
    expect(tabTrigger().querySelector(".italic")?.textContent).toBe("Design review");
    expect(container.querySelector('[data-workspace-tab-trigger="home"] .italic')).toBeNull();

    await act(async () => tabTrigger().click());
    expect(mocks.focusTab).toHaveBeenCalledWith("chat-a");
    expect(mocks.keepTabOpen).not.toHaveBeenCalled();
    await act(async () => tabTrigger().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("chat-a");

    mocks.preview = false;
    await act(async () => root.render(<WorkspaceTabs />));
    expect(tabTrigger().querySelector(".italic")).toBeNull();
    expect(tabTrigger().title).toBe("Design review");
  });

  it("opens Keep open from the keyboard and restores focus after activating it", async () => {
    const menu = await openKeyboardMenu();
    expect(menu?.querySelector('[role="menu"]')).not.toBeNull();
    const keepOpen = menu.querySelector<HTMLButtonElement>('[data-testid="conversation-tab-menu-keep-open"]');
    expect(document.activeElement).toBe(keepOpen);
    await act(async () => {
      keepOpen?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      keepOpen?.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("chat-a");
    expect(document.querySelector('[data-testid="conversation-tab-menu"]')).toBeNull();
    expect(document.activeElement).toBe(tabTrigger());
  });

  it.each(["panel", "file"])("exposes Keep open with the same keyboard and double-click controls for %s previews", async kind => {
    mocks.kind = kind;
    await act(async () => root.render(<WorkspaceTabs />));
    expect(tabTrigger().getAttribute("aria-label")).toContain("preview tab");
    await act(async () => tabTrigger().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("chat-a");
    mocks.keepTabOpen.mockClear();
    const menu = await openKeyboardMenu();
    const keep = menu.querySelector<HTMLButtonElement>('[data-testid="conversation-tab-menu-keep-open"]')!;
    expect(document.activeElement).toBe(keep);
    expect(menu.querySelector('[data-testid="conversation-tab-menu-new-thread"]')).toBeNull();
    expect(menu.querySelector('[data-testid="conversation-tab-menu-delete"]')).toBeNull();
    await act(async () => keep.click());
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("chat-a");
    expect(document.activeElement).toBe(tabTrigger());
  });

  it("supports context-menu-key opening, arrow navigation and Escape without keeping the preview", async () => {
    const menu = await openKeyboardMenu("ContextMenu", false);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(menu.querySelector('[data-testid="conversation-tab-menu-new-thread"]'));
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[data-testid="conversation-tab-menu"]')).toBeNull();
    expect(document.activeElement).toBe(tabTrigger());
    expect(mocks.keepTabOpen).not.toHaveBeenCalled();
  });

  it("does not show Keep open for a permanent tab", async () => {
    mocks.preview = false;
    await act(async () => root.render(<WorkspaceTabs />));
    const menu = await openKeyboardMenu();
    expect(menu.querySelector('[data-testid="conversation-tab-menu-keep-open"]')).toBeNull();
    expect(document.activeElement).toBe(menu.querySelector('[data-testid="conversation-tab-menu-new-thread"]'));
  });
});
