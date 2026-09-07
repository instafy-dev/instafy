// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { NotificationInboxItem } from "../../../../sdk/instafy";
import type { ActivityItem } from "../../../../services/runtimeController/activity";
import { HomePanel } from "../HomePanel";

const mocks = vi.hoisted(() => ({
  activity: {
    activityItems: [] as ActivityItem[],
    activityLoading: false,
    activityLoadingMore: false,
    activityHasMore: false,
    activityError: null as string | null,
    serverLastSeenEventId: null as string | null,
    loadMoreActivity: vi.fn<() => Promise<boolean>>(),
    retryActivity: vi.fn<() => Promise<boolean>>(),
  },
  conversations: [] as ConversationState[],
  organizations: vi.fn(),
  acknowledgeInbox: vi.fn(),
  startChat: vi.fn(),
  startProject: vi.fn(),
  markConversationRead: vi.fn(),
  openConversationTab: vi.fn(),
  navigate: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("../../useHomeActivity", () => ({ useHomeActivity: () => mocks.activity }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../../../projects/useProjects", () => ({
  useProjects: () => ({
    projectList: [{ id: "project-personal", name: "My space", orgId: null, orgName: "Personal" }],
    activeProjectId: "project-personal",
  }),
}));
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: mocks.conversations,
    createConversation: vi.fn(),
    markConversationRead: mocks.markConversationRead,
    setConversationControllerId: vi.fn(),
  }),
}));
vi.mock("../../../../providers/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "viewer" } }),
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ requestUrlPush: vi.fn(), openConversationTab: mocks.openConversationTab }),
}));
vi.mock("../../workspaceControls", () => ({
  useWorkspaceControls: () => ({
    userEmail: "home-review@example.test",
    onStartNewConversation: mocks.startChat,
    onStartNewProject: mocks.startProject,
  }),
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    organizations: { list: mocks.organizations },
    notifications: { acknowledgeInboxItem: mocks.acknowledgeInbox },
  },
}));

function activityItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "20",
    kind: "conversation.reply",
    at: "2026-09-06T12:00:00Z",
    project: { id: "project-personal", name: "My space" },
    org: null,
    conversation: { id: "conversation-recent", title: "Recent work", visibility: "public", threadKind: null },
    run: null,
    actor: { kind: "system", userId: null, displayName: null, handle: null, avatarSeed: null },
    title: "Recent work",
    preview: "The update is ready.",
    needsYou: false,
    live: false,
    seen: false,
    data: {},
    ...overrides,
  };
}

function inboxItem(overrides: Partial<NotificationInboxItem> = {}): NotificationInboxItem {
  return {
    projectId: "project-personal",
    projectName: "My space",
    orgId: null,
    orgName: "Personal",
    conversationId: "conversation-unread",
    conversationTitle: "Unread work",
    lastMessageId: "message-unread",
    lastMessageAt: "2026-09-06T12:30:00Z",
    lastMessagePreview: "Please check the change.",
    lastMessageType: "assistant_message",
    ...overrides,
  };
}

describe("HomePanel activity states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    vi.clearAllMocks();
    Object.assign(mocks.activity, {
      activityItems: [], activityLoading: false, activityLoadingMore: false,
      activityHasMore: false, activityError: null, serverLastSeenEventId: null,
    });
    mocks.activity.loadMoreActivity.mockResolvedValue(true);
    mocks.activity.retryActivity.mockResolvedValue(true);
    mocks.organizations.mockResolvedValue([{ id: "team-design", name: "Design review", slug: "design-review" }]);
    mocks.acknowledgeInbox.mockResolvedValue({ success: true });
    mocks.conversations = [];
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

  async function render(props: ComponentProps<typeof HomePanel> = {}) {
    await act(async () => root.render(<HomePanel {...props} />));
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return container.querySelector<T>(`[data-testid="${testId}"]`);
  }

  async function click(testId: string) {
    const button = query<HTMLButtonElement>(testId);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  it("lets a filtered team load history even when the loaded page has no matching rows", async () => {
    mocks.activity.activityItems = [activityItem()];
    mocks.activity.activityHasMore = true;
    await render();
    await click("home-team-chip-team-design");

    expect(container.textContent).toContain("No activity from Design review in the loaded history.");
    expect(container.textContent).not.toContain("Quiet");
    expect(container.textContent).not.toContain("No spaces in Design review yet.");
    expect(query("home-empty")).toBeNull();
    expect(query("home-recent-load-older")?.textContent).toContain("Load older activity");
    await click("home-recent-load-older");
    expect(mocks.activity.loadMoreActivity).toHaveBeenCalledTimes(1);

    mocks.activity.activityItems = [activityItem(), activityItem({
      id: "10", title: "Design feedback", org: { id: "team-design", name: "Design review" },
      project: { id: "project-design", name: "Design space" },
      conversation: { id: "conversation-design", title: "Design feedback", visibility: "public", threadKind: null },
    })];
    mocks.activity.activityHasMore = false;
    await render();
    expect(query("home-recent-item-10")?.textContent).toContain("Design feedback");
    expect(container.textContent).not.toContain("No activity from Design review in the loaded history.");
  });

  it("guards filtered pagination while an older page is loading", async () => {
    mocks.activity.activityItems = [activityItem()];
    mocks.activity.activityHasMore = true;
    await render();
    await click("home-team-chip-team-design");
    mocks.activity.activityLoadingMore = true;
    await render();

    expect(query<HTMLButtonElement>("home-recent-load-older")?.disabled).toBe(true);
    await click("home-recent-load-older");
    expect(mocks.activity.loadMoreActivity).not.toHaveBeenCalled();
  });

  it("guards regular pagination while an older page is loading", async () => {
    mocks.activity.activityItems = [activityItem()];
    mocks.activity.activityHasMore = true;
    mocks.activity.activityLoadingMore = true;
    await render();
    expect(query<HTMLButtonElement>("home-recent-show-more")?.disabled).toBe(true);
    await click("home-recent-show-more");
    expect(mocks.activity.loadMoreActivity).not.toHaveBeenCalled();
  });

  it("does not present incomplete global activity as a first-use empty state", async () => {
    mocks.activity.activityHasMore = true;
    await render();

    expect(query("home-empty")).toBeNull();
    expect(container.textContent).not.toContain("Nothing here yet");
    expect(container.textContent).toContain("No recent activity in the loaded history.");
    await click("home-recent-load-older");
    expect(mocks.activity.loadMoreActivity).toHaveBeenCalledTimes(1);
  });

  it("shows failed loading as a retryable error rather than an empty account", async () => {
    mocks.activity.activityError = "Unable to load activity: connection lost";
    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Activity couldn’t be loaded.");
    expect(query("home-empty")).toBeNull();
    expect(container.textContent).not.toContain("Quiet so far.");
    await click("home-activity-retry");
    expect(mocks.activity.retryActivity).toHaveBeenCalledTimes(1);
  });

  it("keeps existing activity visible when loading the next page fails", async () => {
    mocks.activity.activityItems = [activityItem()];
    mocks.activity.activityHasMore = true;
    mocks.activity.activityError = "Unable to load older activity";
    await render();

    expect(query("home-recent-item-20")?.textContent).toContain("Recent work");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Loaded items are still shown.");
    await click("home-activity-retry");
    expect(mocks.activity.retryActivity).toHaveBeenCalledTimes(1);
  });

  it("distinguishes unread messages from the previous-visit boundary", async () => {
    mocks.activity.activityItems = [activityItem(), activityItem({
      id: "10", at: "2026-09-06T11:00:00Z", title: "Earlier work",
      conversation: { id: "conversation-earlier", title: "Earlier work", visibility: "public", threadKind: null },
    })];
    mocks.activity.serverLastSeenEventId = "15";
    await render({ inboxItems: [inboxItem()] });

    const headings = Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent);
    expect(headings).toContain("Unread");
    expect(headings).toContain("Recent activity");
    expect(query("home-since-cut")?.textContent).toContain("Earlier activity");
    expect(query("home-since-cut")?.getAttribute("aria-label")).toBe("Earlier activity");
    expect(container.textContent).not.toContain("You're caught up");
    expect(query("home-create")).toBeNull();
  });

  it("preserves the direct first-chat action without adding another create menu", async () => {
    await render();
    expect(query("home-empty")?.textContent).toContain("Nothing here yet");
    expect(query("home-create")).toBeNull();
    await click("home-start-first-chat");
    expect(mocks.startChat).toHaveBeenCalledTimes(1);
  });

  it("identifies team before space in All even when another membership has no loaded activity", async () => {
    mocks.activity.activityItems = [activityItem()];
    await render();

    expect(query("home-team-chip-team-design")?.textContent).toContain("Design review");
    expect(query("home-recent-item-20")?.textContent).toContain("The update is ready.");
    expect(query("home-recent-item-20")?.textContent).toContain("Personal · My space");
  });

  it("shows team provenance for a mixed feed and removes it when filtered to one team", async () => {
    mocks.activity.activityItems = [activityItem(), activityItem({
      id: "10", title: "Design feedback", org: { id: "team-design", name: "Design review" },
      project: { id: "project-design", name: "Design space" },
      conversation: { id: "conversation-design", title: "Design feedback", visibility: "public", threadKind: null },
    })];
    await render();

    expect(query("home-recent-item-20")?.textContent).toContain("Personal · My space");
    expect(query("home-recent-item-10")?.textContent).toContain("Design review · Design space");
    await click("home-team-chip-team-design");
    expect(query("home-recent-item-20")).toBeNull();
    expect(query("home-recent-item-10")?.textContent).toContain("Design feedback");
    expect(query("home-recent-item-10")?.textContent).not.toContain("Design review");
    expect(query("home-recent-item-10")?.textContent).not.toContain("Design space");
  });

  it("preserves space provenance for distinct same-named spaces inside a selected team", async () => {
    mocks.activity.activityItems = [
      activityItem({ project: { id: "project-one", name: "Untitled Space" } }),
      activityItem({
        id: "10", title: "Second space work", project: { id: "project-two", name: "Untitled Space" },
        conversation: { id: "conversation-second", title: "Second space work", visibility: "public", threadKind: null },
      }),
    ];
    await render();
    expect(query("home-recent-item-20")?.textContent).toContain("Personal · Untitled Space");
    expect(query("home-recent-item-10")?.textContent).toContain("Personal · Untitled Space");
    await click("home-team-chip-personal");

    expect(query("home-recent-item-20")?.textContent).toContain("Untitled Space");
    expect(query("home-recent-item-10")?.textContent).toContain("Untitled Space");
    expect(query("home-recent-item-20")?.textContent).not.toContain("Personal");
    expect(query("home-recent-item-10")?.textContent).not.toContain("Personal");
  });

  it("does not repeat the only team and space when there is no team filter", async () => {
    mocks.organizations.mockResolvedValue([]);
    mocks.activity.activityItems = [activityItem()];
    await render();

    expect(query("home-team-filters")).toBeNull();
    expect(query("home-recent-item-20")?.textContent).toContain("Recent work");
    expect(query("home-recent-item-20")?.textContent).not.toContain("Personal");
    expect(query("home-recent-item-20")?.textContent).not.toContain("My space");
  });

  it("keeps an unread failed-run message independently markable as read", async () => {
    const failed = inboxItem({
      conversationTitle: "Scheduled cleanup", lastMessagePreview: "Run failed: runtime unavailable",
      lastMessageType: "run_failed",
    });
    await render({ inboxItems: [failed] });
    const row = query("home-attention-conversation-conversation-unread");
    expect(row?.textContent).toContain("Scheduled cleanup");
    const dismiss = query("home-attention-conversation-conversation-unread-dismiss");
    expect(dismiss?.getAttribute("aria-label")).toBe("Mark Scheduled cleanup as read");
    await click("home-attention-conversation-conversation-unread-dismiss");

    expect(mocks.acknowledgeInbox).toHaveBeenCalledWith({ conversationId: "conversation-unread" });
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(query("home-attention-conversation-conversation-unread")).toBeNull();
  });
});
