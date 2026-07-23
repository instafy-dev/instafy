import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { NotificationInboxItem } from "../../../../sdk/instafy";
import type { ChatMessage } from "../../types";
import {
  buildHomeAttentionEntries,
  excludeVisibleConversationInboxItems,
} from "../../homeAttention";

function createMessage(id: string, content: string, timestamp: number): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp,
  };
}

function createConversation(
  localId: string,
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    localId,
    title: overrides.title ?? `Conversation ${localId}`,
    visibility: overrides.visibility ?? "public",
    lifecycleStatus: overrides.lifecycleStatus ?? "active",
    controllerId: overrides.controllerId ?? localId,
    parentConversationId: overrides.parentConversationId ?? null,
    threadKind: overrides.threadKind ?? null,
    ownerAgent: overrides.ownerAgent ?? null,
    originMessageId: overrides.originMessageId ?? null,
    delegatedByAgentId: overrides.delegatedByAgentId ?? null,
    messages:
      overrides.messages ??
      [createMessage(`${localId}-message`, `Preview for ${localId}`, Date.parse("2026-03-16T11:55:00Z"))],
    draft: overrides.draft ?? "",
    draftEditorState: overrides.draftEditorState ?? null,
    assistantEnabled: overrides.assistantEnabled ?? true,
    extraAgentHandles: overrides.extraAgentHandles ?? [],
    unreadCount: overrides.unreadCount ?? 0,
    createdAt: overrides.createdAt ?? Date.parse("2026-03-16T11:50:00Z"),
    pendingRunIds: overrides.pendingRunIds ?? [],
    awaitingLeaseRunIds: overrides.awaitingLeaseRunIds ?? [],
    pendingRunSubmittedAt: overrides.pendingRunSubmittedAt ?? {},
    runtimePreference: overrides.runtimePreference ?? null,
    activeGoal: overrides.activeGoal ?? null,
  };
}

function createInboxItem(
  conversationId: string,
  overrides: Partial<NotificationInboxItem> = {},
): NotificationInboxItem {
  return {
    projectId: overrides.projectId ?? "project-1",
    projectName: overrides.projectName ?? "Alpha Space",
    orgId: overrides.orgId ?? "org-1",
    orgName: overrides.orgName ?? "Instafy",
    conversationId,
    conversationTitle: overrides.conversationTitle ?? `Inbox ${conversationId}`,
    lastMessageId: overrides.lastMessageId ?? `${conversationId}-message`,
    lastMessageAt: overrides.lastMessageAt ?? "2026-03-16T11:55:00Z",
    lastMessagePreview: overrides.lastMessagePreview ?? `Reply for ${conversationId}`,
    lastMessageType: overrides.lastMessageType ?? "assistant_message",
  };
}

describe("homeAttention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one deduped list across conversation and inbox attention sources", () => {
    const entries = buildHomeAttentionEntries({
      currentSpaceName: "Alpha Space",
      conversations: [
        createConversation("running", {
          title: "Running job",
          controllerId: "controller-running",
          pendingRunIds: ["run-1"],
          messages: [createMessage("running-message", "Still generating menu", Date.parse("2026-03-16T11:59:00Z"))],
        }),
        createConversation("queued", {
          title: "Queued job",
          controllerId: "controller-queued",
          awaitingLeaseRunIds: ["lease-1"],
          messages: [createMessage("queued-message", "Waiting for runtime", Date.parse("2026-03-16T11:58:00Z"))],
        }),
        createConversation("unread", {
          title: "Unread reply",
          controllerId: "controller-unread",
          unreadCount: 2,
          messages: [createMessage("unread-message", "Please check the latest changes", Date.parse("2026-03-16T11:57:00Z"))],
        }),
      ],
      inboxItems: [
        createInboxItem("controller-unread", {
          conversationTitle: "Duplicate unread reply",
          lastMessagePreview: "This should be deduped",
        }),
        createInboxItem("controller-inbox", {
          conversationTitle: "Inbox-only reply",
          lastMessageAt: "2026-03-16T11:55:00Z",
        }),
      ],
    });

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => `${entry.source}:${entry.kind}`)).toEqual([
      "conversation:running",
      "conversation:queued",
      "conversation:reply",
      "inbox:reply",
    ]);
    expect(entries[2]?.title).toBe("Unread reply");
    expect(entries[3]?.title).toBe("Inbox-only reply");
    expect(entries[3]?.meta).toBe("5m ago");
    expect(entries[2]?.testId).toBe("home-attention-conversation-controller-unread");
    expect(entries[3]?.testId).toBe("home-attention-conversation-controller-inbox");
  });

  it("derives the visible inbox without consuming replies from the active chat", () => {
    const inboxItems = [
      createInboxItem("controller-a"),
      createInboxItem("controller-b"),
    ];

    const whileViewingA = excludeVisibleConversationInboxItems(inboxItems, " CONTROLLER-A ");
    const afterSwitchingToB = excludeVisibleConversationInboxItems(inboxItems, "controller-b");

    expect(whileViewingA.map((item) => item.conversationId)).toEqual(["controller-b"]);
    expect(afterSwitchingToB.map((item) => item.conversationId)).toEqual(["controller-a"]);
    expect(inboxItems.map((item) => item.conversationId)).toEqual([
      "controller-a",
      "controller-b",
    ]);
  });

  it("omits active-chat conversation and inbox attention while keeping other replies", () => {
    const entries = buildHomeAttentionEntries({
      currentSpaceName: "Alpha Space",
      visibleConversationLocalId: "local-a",
      visibleConversationControllerId: "controller-a",
      conversations: [
        createConversation("local-a", {
          controllerId: "controller-a",
          unreadCount: 1,
        }),
        createConversation("local-b", {
          controllerId: "controller-b",
          unreadCount: 1,
        }),
      ],
      inboxItems: [
        createInboxItem("controller-a"),
        createInboxItem("controller-c"),
      ],
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      "reply-local-b",
      "inbox-controller-c",
    ]);
  });

  it("keeps the queue uncapped so cross-team inbox items are never crowded out", () => {
    const entries = buildHomeAttentionEntries({
      currentSpaceName: "Alpha Space",
      conversations: [
        createConversation("running-a", { pendingRunIds: ["run-a"], createdAt: Date.parse("2026-03-16T11:59:00Z") }),
        createConversation("running-b", { pendingRunIds: ["run-b"], createdAt: Date.parse("2026-03-16T11:58:00Z") }),
        createConversation("running-c", { pendingRunIds: ["run-c"], createdAt: Date.parse("2026-03-16T11:57:00Z") }),
        createConversation("queued-a", { awaitingLeaseRunIds: ["lease-a"], createdAt: Date.parse("2026-03-16T11:56:00Z") }),
        createConversation("queued-b", { awaitingLeaseRunIds: ["lease-b"], createdAt: Date.parse("2026-03-16T11:55:00Z") }),
        createConversation("unread-a", { unreadCount: 1, createdAt: Date.parse("2026-03-16T11:54:00Z") }),
      ],
      inboxItems: [createInboxItem("controller-inbox-extra")],
    });

    expect(entries).toHaveLength(7);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "running",
      "running",
      "running",
      "queued",
      "queued",
      "reply",
      "reply",
    ]);
    expect(entries.at(-1)?.source).toBe("inbox");
  });

  it("honors an explicit limit when one is passed", () => {
    const entries = buildHomeAttentionEntries({
      currentSpaceName: "Alpha Space",
      limit: 5,
      conversations: [
        createConversation("running-a", { pendingRunIds: ["run-a"], createdAt: Date.parse("2026-03-16T11:59:00Z") }),
        createConversation("running-b", { pendingRunIds: ["run-b"], createdAt: Date.parse("2026-03-16T11:58:00Z") }),
        createConversation("running-c", { pendingRunIds: ["run-c"], createdAt: Date.parse("2026-03-16T11:57:00Z") }),
        createConversation("queued-a", { awaitingLeaseRunIds: ["lease-a"], createdAt: Date.parse("2026-03-16T11:56:00Z") }),
        createConversation("queued-b", { awaitingLeaseRunIds: ["lease-b"], createdAt: Date.parse("2026-03-16T11:55:00Z") }),
        createConversation("unread-a", { unreadCount: 1, createdAt: Date.parse("2026-03-16T11:54:00Z") }),
      ],
      inboxItems: [createInboxItem("controller-inbox-extra")],
    });

    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.source === "conversation")).toBe(true);
  });
});
