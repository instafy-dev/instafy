import { describe, expect, it } from "vitest";

import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import { resolveHomeRecentConversationNavigationTarget } from "../homeRecentConversationNavigation";

function createConversation(
  localId: string,
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    localId,
    title: overrides.title ?? `Conversation ${localId}`,
    visibility: overrides.visibility ?? "public",
    lifecycleStatus: overrides.lifecycleStatus ?? "active",
    controllerId: overrides.controllerId ?? null,
    parentConversationId: overrides.parentConversationId ?? null,
    threadKind: overrides.threadKind ?? null,
    ownerAgent: overrides.ownerAgent ?? null,
    originMessageId: overrides.originMessageId ?? null,
    delegatedByAgentId: overrides.delegatedByAgentId ?? null,
    messages: overrides.messages ?? [],
    draft: overrides.draft ?? "",
    draftEditorState: overrides.draftEditorState ?? null,
    assistantEnabled: overrides.assistantEnabled ?? true,
    extraAgentHandles: overrides.extraAgentHandles ?? [],
    unreadCount: overrides.unreadCount ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
    pendingRunIds: overrides.pendingRunIds ?? [],
    awaitingLeaseRunIds: overrides.awaitingLeaseRunIds ?? [],
    pendingRunSubmittedAt: overrides.pendingRunSubmittedAt ?? {},
    runtimePreference: overrides.runtimePreference ?? null,
    activeGoal: overrides.activeGoal ?? null,
  };
}

describe("homeRecentConversationNavigation", () => {
  it("reopens a local conversation when the recent row only carries a controller id", () => {
    const target = resolveHomeRecentConversationNavigationTarget({
      activeProjectId: "project-1",
      conversations: [
        createConversation("local-1", {
          controllerId: "controller-1",
        }),
      ],
      entry: {
        projectId: "project-1",
        localConversationId: null,
        conversationId: "controller-1",
      },
    });

    expect(target).toEqual({
      kind: "local",
      localConversationId: "local-1",
    });
  });

  it("navigates when the recent row belongs to another project", () => {
    const target = resolveHomeRecentConversationNavigationTarget({
      activeProjectId: "project-1",
      conversations: [
        createConversation("local-1", {
          controllerId: "controller-1",
        }),
      ],
      entry: {
        projectId: "project-2",
        localConversationId: null,
        conversationId: "controller-2",
      },
    });

    expect(target).toEqual({
      kind: "route",
      projectId: "project-2",
      conversationControllerId: "controller-2",
    });
  });
});
