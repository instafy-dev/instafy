type ConversationHumanLike = {
  userId: string;
};

export type GettingStartedConversationContext = {
  relevant: boolean;
  resolved: boolean;
};

export type ConversationHumanPeerContext = {
  hasHumanPeer: boolean;
  resolved: boolean;
};

type ConversationHumanPeerContextInput = {
  conversationVisibility: "public" | "private" | null;
  controllerConversationId: string | null;
  currentUserId: string | null;
  orgMemberError: string | null;
  orgMemberLoading: boolean;
  orgMembers: readonly ConversationHumanLike[];
  participantError: string | null;
  participantLoading: boolean;
  participants: readonly ConversationHumanLike[];
  projectMemberError: string | null;
  projectMemberLoading: boolean;
  projectMembers: readonly ConversationHumanLike[];
  runtimeControllerEnabled: boolean;
};

export function resolveConversationHumanPeerContext({
  conversationVisibility,
  controllerConversationId,
  currentUserId,
  orgMemberError,
  orgMemberLoading,
  orgMembers,
  participantError,
  participantLoading,
  participants,
  projectMemberError,
  projectMemberLoading,
  projectMembers,
  runtimeControllerEnabled,
}: ConversationHumanPeerContextInput): ConversationHumanPeerContext {
  if (!runtimeControllerEnabled || !controllerConversationId) {
    return { hasHumanPeer: false, resolved: false };
  }

  const normalizedCurrentUserId = currentUserId?.trim() ?? "";
  if (!normalizedCurrentUserId || participantLoading || participantError) {
    return { hasHumanPeer: false, resolved: false };
  }

  // Public conversation participation includes project and authorized org
  // members even before a person opens or sends to the conversation. Resolve
  // those already-authorized directories before inspecting cached peer data;
  // React Query may retain stale rows after a failed permission refresh.
  if (
    conversationVisibility === "public" &&
    (orgMemberLoading ||
      orgMemberError ||
      projectMemberLoading ||
      projectMemberError)
  ) {
    return { hasHumanPeer: false, resolved: false };
  }

  const hasParticipantPeer = participants.some((participant) => {
    const participantUserId = participant.userId.trim();
    return participantUserId.length > 0 && participantUserId !== normalizedCurrentUserId;
  });
  const hasPublicProjectPeer =
    conversationVisibility === "public" &&
    projectMembers.some((member) => {
      const memberUserId = member.userId.trim();
      return memberUserId.length > 0 && memberUserId !== normalizedCurrentUserId;
    });
  const hasPublicOrgPeer =
    conversationVisibility === "public" &&
    orgMembers.some((member) => {
      const memberUserId = member.userId.trim();
      return memberUserId.length > 0 && memberUserId !== normalizedCurrentUserId;
    });

  return {
    hasHumanPeer: hasParticipantPeer || hasPublicProjectPeer || hasPublicOrgPeer,
    resolved: true,
  };
}

export function resolveGettingStartedConversationContext({
  anyAgentsEnabled,
  conversationVisibility,
  controllerConversationId,
  currentUserId,
  orgMemberError,
  orgMemberLoading,
  orgMembers,
  participantError,
  participantLoading,
  participants,
  projectMemberError,
  projectMemberLoading,
  projectMembers,
  runtimeControllerEnabled,
}: {
  anyAgentsEnabled: boolean;
  conversationVisibility: "public" | "private" | null;
  controllerConversationId: string | null;
  currentUserId: string | null;
  orgMemberError: string | null;
  orgMemberLoading: boolean;
  orgMembers: readonly ConversationHumanLike[];
  participantError: string | null;
  participantLoading: boolean;
  participants: readonly ConversationHumanLike[];
  projectMemberError: string | null;
  projectMemberLoading: boolean;
  projectMembers: readonly ConversationHumanLike[];
  runtimeControllerEnabled: boolean;
}): GettingStartedConversationContext {
  // An AI-enabled conversation is an intentional AI entry point regardless of
  // how many people are present, so it should retain the explicit first-run
  // choices without waiting for the participant directory.
  if (anyAgentsEnabled) {
    return { relevant: true, resolved: true };
  }

  // Local/pending conversations do not have a shared participant directory.
  // Preserve the established single-user onboarding experience there.
  if (!runtimeControllerEnabled || !controllerConversationId) {
    return { relevant: true, resolved: true };
  }

  const peerContext = resolveConversationHumanPeerContext({
    conversationVisibility,
    controllerConversationId,
    currentUserId,
    orgMemberError,
    orgMemberLoading,
    orgMembers,
    participantError,
    participantLoading,
    participants,
    projectMemberError,
    projectMemberLoading,
    projectMembers,
    runtimeControllerEnabled,
  });
  if (!peerContext.resolved) {
    return { relevant: false, resolved: false };
  }
  return { relevant: !peerContext.hasHumanPeer, resolved: true };
}
