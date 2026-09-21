// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { NotificationInboxItem } from "../../../../sdk/instafy";
import type { ActivityItem } from "../../../../services/runtimeController/activity";
import type { ProductNotification } from "../../../../notifications/notificationContract";
import type { HomeNotifications } from "../../../../notifications/useNotificationCenter";
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
  userId: "viewer",
  accessToken: "viewer-token",
  activeProjectId: "project-personal",
  projects: [] as Array<{ id: string; name: string; orgId: string | null; orgName: string }>,
  organizations: vi.fn(),
  acknowledgeInbox: vi.fn(),
  startChat: vi.fn(),
  startProject: vi.fn(),
  openOrgSettings: vi.fn(),
  markConversationRead: vi.fn(),
  openConversationTab: vi.fn(),
  requestUrlPush: vi.fn(),
  navigate: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("../../useHomeActivity", () => ({ useHomeActivity: () => mocks.activity }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router-dom")>(),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../../../../projects/useProjects", () => ({
  useProjects: () => ({
    projectList: mocks.projects,
    activeProjectId: mocks.activeProjectId,
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
  useAuth: () => ({ user: { id: mocks.userId }, session: { access_token: mocks.accessToken } }),
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ requestUrlPush: mocks.requestUrlPush, openConversationTab: mocks.openConversationTab }),
}));
vi.mock("../../workspaceControls", () => ({
  useWorkspaceControls: () => ({
    userEmail: "home-review@example.test",
    onStartNewConversation: mocks.startChat,
    onStartNewProject: mocks.startProject,
    onOpenOrgSettings: mocks.openOrgSettings,
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

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const REPORT = "33333333-3333-4333-8333-333333333333";
const EVENT_A = "44444444-4444-4444-8444-444444444444";
const EVENT_B = "55555555-5555-4555-8555-555555555555";
const EVENT_C = "66666666-6666-4666-8666-666666666666";
const MESSAGE = "77777777-7777-4777-8777-777777777777";
const AUTOMATION = "88888888-8888-4888-8888-888888888888";

function notification(overrides: Partial<ProductNotification> = {}): ProductNotification {
  return {
    id: EVENT_A, eventName: "support.reply", category: "support", version: 1,
    resourceType: "support_report", resourceId: REPORT, occurredAt: "2026-09-06T12:30:00Z",
    title: "Instafy", body: "There is a new reply to your support report.",
    url: `/studio?supportReportId=${REPORT}`, readAt: null, seenAt: null, archivedAt: null,
    ...overrides,
  };
}

function notificationState(items: ProductNotification[], overrides: Partial<HomeNotifications> = {}): HomeNotifications {
  return {
    page: { items, nextCursor: null, unreadCount: items.filter(item => !item.readAt && !item.archivedAt).length, asOf: "2026-09-06T12:35:00Z" },
    loading: false, error: null, refresh: vi.fn(async () => {}), loadMore: vi.fn(async () => {}),
    markRead: vi.fn(async () => true), ...overrides,
  };
}

function localConversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    localId: "local-unread", controllerId: CONVERSATION, title: "Local unread work", visibility: "shared",
    lifecycleStatus: "active", parentConversationId: null, threadKind: null, ownerAgent: null,
    activeGoal: null, originMessageId: null, delegatedByAgentId: null,
    messages: [{ id: MESSAGE, role: "assistant", content: "Please review the change", timestamp: Date.parse("2026-09-06T12:30:00Z") }],
    draft: "", draftEditorState: null, assistantEnabled: true, extraAgentHandles: [], unreadCount: 1,
    createdAt: Date.parse("2026-09-06T12:00:00Z"), pendingRunIds: [], awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {}, runtimePreference: null, ...overrides,
  } as ConversationState;
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
    mocks.acknowledgeInbox.mockImplementation(async ({ notificationIds = [] }: { notificationIds?: string[] }) => ({ success: true, inboxAcknowledged: true, acknowledgedNotificationIds: notificationIds }));
    mocks.conversations = [];
    mocks.userId = "viewer";
    mocks.accessToken = "viewer-token";
    mocks.activeProjectId = "project-personal";
    mocks.projects = [{ id: "project-personal", name: "My space", orgId: null, orgName: "Personal" }];
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
    await act(async () => root.render(<BrowserRouter><HomePanel {...props} /></BrowserRouter>));
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return container.querySelector<T>(`[data-testid="${testId}"]`);
  }

  async function click(testId: string) {
    const button = query<HTMLButtonElement>(testId);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  async function clickLabel(label: string) {
    const button = [...container.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
  }

  it("opens unloaded Home activity with one destination, without a competing tab push", async () => {
    window.history.replaceState(null, "", "/studio?projectId=project-personal&panel=home&jobId=old-job&settingsCategory=danger");
    mocks.activity.activityItems = [activityItem()];
    await render();
    await click("home-recent-item-20");
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const [target, options] = mocks.navigate.mock.calls[0];
    const params = new URLSearchParams(target.search);
    expect(target.pathname).toBe("/studio");
    expect(params.get("conversationControllerId")).toBe("conversation-recent");
    expect(params.get("panel")).toBeNull();
    expect(params.get("jobId")).toBeNull();
    expect(params.get("settingsCategory")).toBeNull();
    expect(options).toEqual({ state: null });
    expect(mocks.requestUrlPush).not.toHaveBeenCalled();
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
  });

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

  it("opens Invite people in Members using the current team fallback from All", async () => {
    await render();
    await click("home-invite-people");
    expect(mocks.openOrgSettings).toHaveBeenCalledExactlyOnceWith(null, "members");
  });

  it("opens Invite people in the filtered team's Members section", async () => {
    await render();
    await click("home-team-chip-team-design");
    await click("home-invite-people");
    expect(mocks.openOrgSettings).toHaveBeenCalledExactlyOnceWith("team-design", "members");
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

    expect(mocks.acknowledgeInbox).toHaveBeenCalledWith({
      conversationId: "conversation-unread", expectedLastMessageId: "message-unread", notificationIds: [], accessToken: "viewer-token",
      expectedUserId: "viewer", isCurrent: expect.any(Function),
    });
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    // The controller's next inbox snapshot owns removal; no stable local key
    // is allowed to suppress a reply that arrives during acknowledgement.
    expect(query("home-attention-conversation-conversation-unread")).not.toBeNull();
    await render({ inboxItems: [] });
    expect(query("home-attention-conversation-conversation-unread")).toBeNull();
  });

  it.each([
    ["support.reply", "support", `/studio?supportReportId=${REPORT}`, REPORT, "Support replied"],
    ["automation.failed", "automations", `/studio?projectId=${PROJECT}&panel=automations`, AUTOMATION, "Automation failed"],
  ] as const)("places %s in Home's existing unread lane and opens the canonical destination", async (eventName, category, url, resourceId, title) => {
    const item = notification({ eventName, category, url, resourceId });
    const notifications = notificationState([item]);
    await render({ notifications });
    expect(query(`home-notification-${EVENT_A}`)?.textContent).toContain(title);
    expect(query("home-attention-section")?.contains(query(`home-notification-${EVENT_A}`)!)).toBe(true);
    expect(query("notification-center-bell")).toBeNull();
    expect(query("notification-center")).toBeNull();
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Inbox")).toBe(false);
    await click(`home-notification-${EVENT_A}`);
    expect(notifications.markRead).toHaveBeenCalledExactlyOnceWith([item]);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("marks only loaded unread groups in the selected team's feed without using a global watermark", async () => {
    mocks.projects.push({ id: PROJECT, name: "Release space", orgId: "team-design", orgName: "Design review" });
    const first = notification({ eventName: "automation.failed", category: "automations", resourceId: AUTOMATION, url: `/studio?projectId=${PROJECT}&panel=automations` });
    const second = notification({ ...first, id: EVENT_B, occurredAt: "2026-09-06T12:20:00Z" });
    const unrelated = notification({ id: EVENT_C });
    const notifications = notificationState([first, second, unrelated]);
    await render({ notifications });
    await click("home-team-chip-team-design");
    expect(query(`home-notification-${EVENT_C}`)).toBeNull();
    await clickLabel("Mark all read");
    expect(notifications.markRead).toHaveBeenCalledExactlyOnceWith([first, second]);
    expect(mocks.acknowledgeInbox).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("reads the inbox once on mount and does not start its own inbox interval", async () => {
    vi.useFakeTimers();
    try {
      const refreshInbox = vi.fn(async () => []);
      await render({ refreshInbox });
      expect(refreshInbox).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(refreshInbox).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges a conversation's inbox and durable updates into one row and acknowledges the exact displayed snapshot", async () => {
    const inbox = inboxItem({ projectId: PROJECT, conversationId: CONVERSATION, lastMessageId: MESSAGE });
    const reply = notification({ eventName: "conversation.reply", category: "conversations", resourceId: CONVERSATION, url: `/studio?projectId=${PROJECT}&conversationControllerId=${CONVERSATION}` });
    const failure = notification({ ...reply, id: EVENT_B, eventName: "run.failed", category: "runs", occurredAt: "2026-09-06T12:20:00Z" });
    const alreadyRead = notification({ ...reply, id: EVENT_C, readAt: "2026-09-06T12:25:00Z", occurredAt: "2026-09-06T12:15:00Z" });
    const notifications = notificationState([reply, failure, alreadyRead]);
    const refreshInbox = vi.fn(async () => []);
    await render({ inboxItems: [inbox], notifications, refreshInbox });
    expect(query(`home-attention-conversation-${CONVERSATION}`)?.textContent).toContain("Unread work");
    expect(query(`home-notification-${EVENT_A}`)).toBeNull();
    expect(query(`home-notification-${EVENT_B}`)).toBeNull();
    await click(`home-attention-conversation-${CONVERSATION}-dismiss`);
    expect(mocks.acknowledgeInbox).toHaveBeenCalledExactlyOnceWith({
      conversationId: CONVERSATION, expectedLastMessageId: MESSAGE, notificationIds: [EVENT_A, EVENT_B], accessToken: "viewer-token",
      expectedUserId: "viewer", isCurrent: expect.any(Function),
    });
    expect(notifications.markRead).not.toHaveBeenCalled();
    expect(notifications.refresh).toHaveBeenCalledWith({ force: true });
    expect(refreshInbox).toHaveBeenCalledWith({ force: true });
  });

  it("keeps a failed inbox snapshot visible and surfaces the error without acknowledging durable updates separately", async () => {
    mocks.acknowledgeInbox.mockResolvedValue({ success: false, error: "Unable to acknowledge snapshot" });
    const item = inboxItem();
    await render({ inboxItems: [item] });
    await click("home-attention-conversation-conversation-unread-dismiss");
    expect(query("home-attention-conversation-conversation-unread")).not.toBeNull();
    expect(mocks.markConversationRead).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalledWith("Unable to acknowledge snapshot", "error", 4000);
  });

  it("leaves local unread state intact when the server reports a newer concurrent reply", async () => {
    mocks.activeProjectId = PROJECT;
    mocks.projects = [{ id: PROJECT, name: "My space", orgId: null, orgName: "Personal" }];
    mocks.conversations = [localConversation()];
    mocks.acknowledgeInbox.mockResolvedValue({ success: true, inboxAcknowledged: false, acknowledgedNotificationIds: [] });
    const item = inboxItem({ projectId: PROJECT, conversationId: CONVERSATION, lastMessageId: MESSAGE });
    await render({ inboxItems: [item] });
    await click(`home-attention-conversation-${CONVERSATION}-dismiss`);
    expect(mocks.acknowledgeInbox).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSATION, expectedLastMessageId: MESSAGE }));
    expect(mocks.markConversationRead).not.toHaveBeenCalled();
    expect(query(`home-attention-conversation-${CONVERSATION}`)).not.toBeNull();
  });

  it("marks the unchanged local conversation read only after its inbox and durable snapshot are acknowledged", async () => {
    mocks.activeProjectId = PROJECT;
    mocks.projects = [{ id: PROJECT, name: "My space", orgId: null, orgName: "Personal" }];
    mocks.conversations = [localConversation()];
    const reply = notification({ eventName: "conversation.reply", category: "conversations", resourceId: CONVERSATION, url: `/studio?projectId=${PROJECT}&conversationControllerId=${CONVERSATION}` });
    const notifications = notificationState([reply]);
    const item = inboxItem({ projectId: PROJECT, conversationId: CONVERSATION, lastMessageId: MESSAGE });
    let complete!: (value: unknown) => void;
    mocks.acknowledgeInbox.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await render({ inboxItems: [item], notifications });
    await click(`home-attention-conversation-${CONVERSATION}-dismiss`);
    expect(mocks.markConversationRead).not.toHaveBeenCalled();
    expect(mocks.acknowledgeInbox).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSATION, expectedLastMessageId: MESSAGE, notificationIds: [EVENT_A] }));
    await act(async () => complete({ success: true, inboxAcknowledged: true, acknowledgedNotificationIds: [EVENT_A] }));
    expect(mocks.markConversationRead).toHaveBeenCalledExactlyOnceWith("local-unread");
    expect(notifications.markRead).not.toHaveBeenCalled();
  });

  it("does not mark local unread state when the server omits one of the requested durable acknowledgements", async () => {
    mocks.activeProjectId = PROJECT;
    mocks.projects = [{ id: PROJECT, name: "My space", orgId: null, orgName: "Personal" }];
    mocks.conversations = [localConversation()];
    const reply = notification({ eventName: "conversation.reply", category: "conversations", resourceId: CONVERSATION, url: `/studio?projectId=${PROJECT}&conversationControllerId=${CONVERSATION}` });
    const notifications = notificationState([reply]);
    mocks.acknowledgeInbox.mockResolvedValue({ success: true, inboxAcknowledged: true, acknowledgedNotificationIds: [] });
    await render({ inboxItems: [inboxItem({ projectId: PROJECT, conversationId: CONVERSATION, lastMessageId: MESSAGE })], notifications });
    await click(`home-attention-conversation-${CONVERSATION}-dismiss`);
    expect(mocks.markConversationRead).not.toHaveBeenCalled();
    expect(query(`home-attention-conversation-${CONVERSATION}`)).not.toBeNull();
    expect(mocks.showStatus).toHaveBeenCalledWith(expect.stringContaining("Unable to mark this update as read"), "error", 4000);
  });

  it.each(["account", "token"] as const)("ignores a snapshot completion after the authenticated %s changes", async (change) => {
    mocks.activeProjectId = PROJECT;
    mocks.projects = [{ id: PROJECT, name: "My space", orgId: null, orgName: "Personal" }];
    mocks.conversations = [localConversation()];
    let complete!: (value: unknown) => void;
    mocks.acknowledgeInbox.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const item = inboxItem({ projectId: PROJECT, conversationId: CONVERSATION, lastMessageId: MESSAGE });
    await render({ inboxItems: [item] });
    await click(`home-attention-conversation-${CONVERSATION}-dismiss`);
    const isCurrent = mocks.acknowledgeInbox.mock.calls[0][0].isCurrent as () => boolean;
    expect(isCurrent()).toBe(true);
    if (change === "account") mocks.userId = "different-viewer";
    mocks.accessToken = "new-token";
    await render({ inboxItems: [item] });
    expect(isCurrent()).toBe(false);
    await act(async () => complete({ success: true, inboxAcknowledged: true, acknowledgedNotificationIds: [] }));
    expect(mocks.markConversationRead).not.toHaveBeenCalled();
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("does not clear a new local message that arrives while the displayed inbox snapshot is being acknowledged", async () => {
    mocks.activeProjectId = PROJECT;
    mocks.projects = [{ id: PROJECT, name: "My space", orgId: null, orgName: "Personal" }];
    const original = localConversation();
    mocks.conversations = [original];
    let complete!: (value: unknown) => void;
    mocks.acknowledgeInbox.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const item = inboxItem({ projectId: PROJECT, conversationId: CONVERSATION, lastMessageId: MESSAGE });
    await render({ inboxItems: [item] });
    await click(`home-attention-conversation-${CONVERSATION}-dismiss`);
    mocks.conversations = [localConversation({ unreadCount: 2, messages: [...original.messages, { id: "new-message", role: "assistant", content: "One more change", timestamp: Date.parse("2026-09-06T12:40:00Z") }] })];
    await render({ inboxItems: [item] });
    await act(async () => complete({ success: true, inboxAcknowledged: true, acknowledgedNotificationIds: [] }));
    expect(mocks.markConversationRead).not.toHaveBeenCalled();
    expect(query(`home-attention-conversation-${CONVERSATION}`)).not.toBeNull();
  });

  it("does not claim Home is empty while notification loading or retryable errors are unresolved", async () => {
    const notifications = notificationState([], { loading: true });
    await render({ notifications });
    expect(query("home-empty")).toBeNull();
    expect(container.textContent).not.toContain("Quiet so far.");
    expect(container.querySelector('[role="status"][aria-label*="Loading"]')).not.toBeNull();
    notifications.loading = false;
    notifications.error = "Updates could not be loaded.";
    await render({ notifications });
    expect(query("home-empty")).toBeNull();
    expect(container.textContent).not.toContain("Quiet so far.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(notifications.error);
    await clickLabel("Retry notifications");
    expect(notifications.refresh).toHaveBeenCalledTimes(1);
    notifications.error = null;
    await render({ notifications });
    expect(query("home-empty")).not.toBeNull();
  });

  it("loads older notifications through Home while preserving activity rows and guarding repeated loading clicks", async () => {
    mocks.activity.activityItems = [activityItem()];
    const notifications = notificationState([]);
    notifications.page.nextCursor = "older-cursor";
    await render({ notifications });
    expect(query("home-recent-item-20")).not.toBeNull();
    await click("home-recent-show-more");
    expect(notifications.loadMore).toHaveBeenCalledTimes(1);
    notifications.loading = true;
    await render({ notifications });
    expect(query<HTMLButtonElement>("home-recent-show-more")?.disabled).toBe(true);
    await click("home-recent-show-more");
    expect(notifications.loadMore).toHaveBeenCalledTimes(1);
  });

  it("opens pre-migration unread support in the existing report flow without inventing a read acknowledgement", async () => {
    const notifications = notificationState([]);
    const report = {
      id: REPORT, title: "Tabs cannot be dragged", projectId: null, activityAt: "2026-09-01T12:00:00Z",
      supportLastMessageAt: "2026-09-01T12:00:00Z", resolvedAt: null, hasUnreadResolution: false,
    };
    await render({ notifications, supportReports: [report] });
    expect(query(`home-support-${REPORT}`)?.textContent).toContain("Tabs cannot be dragged");
    expect(query("home-attention-section")?.contains(query(`home-support-${REPORT}`)!)).toBe(true);
    expect(query(`home-support-${REPORT}-dismiss`)).toBeNull();
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Mark all read")).toBe(false);
    await click(`home-support-${REPORT}`);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(`/studio?supportReportId=${REPORT}`);
    expect(notifications.markRead).not.toHaveBeenCalled();
    expect(mocks.acknowledgeInbox).not.toHaveBeenCalled();
  });

  it("keeps Home out of its empty state while legacy support is loading or cannot be refreshed", async () => {
    const refreshSupport = vi.fn(async () => {});
    await render({ supportLoading: true, refreshSupport });
    expect(query("home-empty")).toBeNull();
    expect(container.querySelector('[role="status"][aria-label*="Loading"]')).not.toBeNull();
    await render({ supportError: "Support updates could not be loaded.", refreshSupport });
    expect(query("home-empty")).toBeNull();
    expect(container.textContent).not.toContain("Quiet so far.");
    await clickLabel("Retry support updates");
    expect(refreshSupport).toHaveBeenCalledTimes(1);
    await render({ supportReports: [], refreshSupport });
    expect(query("home-empty")).not.toBeNull();
  });

  it.each(["legacy", "durable"] as const)("opens %s support through the root report dialog without leaving Home", async (source) => {
    window.history.replaceState(null, "", "/studio?projectId=project-personal&panel=home");
    const homeUrl = window.location.href;
    const onOpenSupport = vi.fn();
    const items = [notification(), notification({ id: EVENT_B, occurredAt: "2026-09-06T12:20:00Z" })];
    const notifications = notificationState(source === "durable" ? items : []);
    const supportReports = source === "legacy" ? [{
      id: REPORT, title: "Tabs cannot be dragged", projectId: null, activityAt: "2026-09-01T12:00:00Z",
      supportLastMessageAt: "2026-09-01T12:00:00Z", resolvedAt: null, hasUnreadResolution: false,
    }] : [];
    await render({ notifications, supportReports, onOpenSupport });
    await click(source === "legacy" ? `home-support-${REPORT}` : `home-notification-${EVENT_A}`);
    expect(onOpenSupport).toHaveBeenCalledExactlyOnceWith(REPORT);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(window.location.href).toBe(homeUrl);
    if (source === "durable") expect(notifications.markRead).toHaveBeenCalledExactlyOnceWith(items);
    else expect(notifications.markRead).not.toHaveBeenCalled();
    expect(mocks.acknowledgeInbox).not.toHaveBeenCalled();
  });
});
