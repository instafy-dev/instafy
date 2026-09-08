// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTabsProps } from "../../../../workspace/WorkspaceTabs";
import { StudioTopBar } from "../StudioTopBar";

const mocks = vi.hoisted(() => ({
  toggleSidebar: vi.fn(),
  keepTabOpen: vi.fn(),
  startNewConversation: vi.fn(),
  isLargeScreen: false,
  showChatActions: false,
  hasTabs: true,
  controllerProjectMissing: false,
  projectAccessBlocked: false,
  tab: { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Draft chat" } as Record<string, string | boolean | undefined>,
}));
vi.mock("../../workspaceControls", () => ({
  useWorkspaceControls: () => ({
    activeProjectName: "My space",
    onToggleSidebar: mocks.toggleSidebar,
    sidebarOpen: false,
    onStartNewConversation: mocks.startNewConversation,
    showChatActions: mocks.showChatActions,
  }),
}));
vi.mock("../../useStudioNavigationPosture", () => ({
  useStudioNavigationPosture: () => ({ isLargeScreen: mocks.isLargeScreen, showComposerNavigationButton: !mocks.isLargeScreen }),
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: "project-1" }) }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "test-user" } }) }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ projectAccessBlocked: mocks.projectAccessBlocked }) }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runtime: { controllerProjectMissing: mocks.controllerProjectMissing } }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    tabs: mocks.hasTabs ? [mocks.tab] : [],
    activeTabId: mocks.hasTabs ? mocks.tab.id : null,
    focusTab: vi.fn(),
    closeTab: vi.fn(),
    keepTabOpen: mocks.keepTabOpen,
    requestUrlPush: vi.fn(),
    openConversationTab: vi.fn(),
  }),
}));
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ conversations: [{ localId: "conversation-1", title: "Draft chat" }] }),
}));
vi.mock("../StudioNewChatButton", () => ({
  StudioNewChatButton: ({ testId }: { testId?: string }) => <button data-testid={testId} aria-label="New chat" />,
}));
vi.mock("../../../../workspace/WorkspaceTabs", () => ({
  WorkspaceTabs: ({ leading, emptyStateContent, tabStripActions, actions }: WorkspaceTabsProps) => (
    <div data-testid="workspace-tabs">{leading}{emptyStateContent}{tabStripActions}{actions}</div>
  ),
}));
// A ready release must not add an acquisition action back into navigation.
vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({
  useDesktopReleaseLookup: () => ({ lookup: { status: "available", manifest: { version: "0.2.0" } } }),
}));

describe("StudioTopBar navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isLargeScreen = false;
    mocks.showChatActions = false;
    mocks.hasTabs = true;
    mocks.controllerProjectMissing = false;
    mocks.projectAccessBlocked = false;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it.each([
    { kind: "conversation", id: "conversation-1", conversationId: "conversation-1", title: "Draft chat" },
    { kind: "panel", id: "home", panel: "home", title: "Home" },
    { kind: "panel", id: "code", panel: "code", title: "Files" },
  ])("keeps sidebar access in $title even when the composer is absent or hidden", async (tab) => {
    mocks.tab = tab as Record<string, string | undefined>;
    await act(async () => root.render(<StudioTopBar />));
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="topbar-sidebar-toggle"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    expect(mocks.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="topbar-home-button"]')).toBeNull();
  });

  it("offers Keep open in the narrow tab switcher without changing the main chat title", async () => {
    mocks.tab = { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Preview chat", preview: true };
    await act(async () => root.render(<StudioTopBar />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="topbar-tab-selector"]');
    expect(trigger?.textContent).toBe("Preview chat");
    expect(trigger?.querySelector(".italic")).toBeNull();
    await act(async () => trigger?.click());
    const keepOpen = document.querySelector<HTMLButtonElement>('[data-testid="topbar-tab-keep-open-conversation-1"]');
    expect(keepOpen?.getAttribute("aria-label")).toBe("Keep Preview chat open");
    expect(keepOpen?.title).toBe("Keep open");
    await act(async () => keepOpen?.click());
    expect(mocks.keepTabOpen).toHaveBeenCalledWith("conversation-1");

    mocks.tab = { ...mocks.tab, preview: false };
    await act(async () => root.render(<StudioTopBar />));
    expect(document.querySelector('[data-testid="topbar-tab-keep-open-conversation-1"]')).toBeNull();
  });

  it("keeps wide tab actions focused on New chat and Browse tabs without an install link", async () => {
    mocks.isLargeScreen = true;
    mocks.showChatActions = true;
    mocks.tab = { id: "conversation-1", kind: "conversation", conversationId: "conversation-1", title: "Draft chat" };
    await act(async () => root.render(<StudioTopBar />));
    const tabStrip = container.querySelector('[data-testid="workspace-tabs"]');
    const newChat = tabStrip?.querySelector('[data-testid="chat-new-conversation"]');
    const browseTabs = tabStrip?.querySelector<HTMLButtonElement>('[data-testid="topbar-tab-overflow"]');
    expect(newChat?.getAttribute("aria-label")).toBe("New chat");
    expect(browseTabs?.getAttribute("aria-label")).toBe("Browse tabs");
    expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    expect(container.querySelector('a[href^="/install"]')).toBeNull();

    await act(async () => browseTabs?.click());
    const currentTab = document.querySelector('[data-testid="topbar-tab-item-conversation-1"]');
    expect(currentTab?.textContent).toBe("Draft chat");
    expect(currentTab?.getAttribute("aria-current")).toBe("page");
  });

  it.each([
    { posture: "wide with tabs", isLargeScreen: true, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false },
    { posture: "wide without tabs", isLargeScreen: true, hasTabs: false, controllerProjectMissing: false, projectAccessBlocked: false },
    { posture: "wide with a missing project", isLargeScreen: true, hasTabs: true, controllerProjectMissing: true, projectAccessBlocked: false },
    { posture: "wide with blocked project access", isLargeScreen: true, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: true },
    { posture: "mobile", isLargeScreen: false, hasTabs: true, controllerProjectMissing: false, projectAccessBlocked: false },
  ])("preserves the notification bell exactly once in $posture", async ({ isLargeScreen, hasTabs, controllerProjectMissing, projectAccessBlocked }) => {
    Object.assign(mocks, { isLargeScreen, hasTabs, controllerProjectMissing, projectAccessBlocked });
    const onOpenNotifications = vi.fn();
    await act(async () => root.render(
      <StudioTopBar notificationBell={<button type="button" aria-label="Notifications" onClick={onOpenNotifications}>Notifications</button>} />,
    ));

    const bells = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Notifications"]');
    expect(bells).toHaveLength(1);
    await act(async () => bells[0].click());
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    expect(container.querySelector('a[href^="/install"]')).toBeNull();
  });
});
