import type { ConversationHumanPeerPresence } from "../../../conversations/groupParticipation";

type RosterHumanSourceMember = {
  userId: string;
};

export type ConversationRosterHuman = {
  userId: string;
  label: string;
  isSelf: boolean;
};

export type ConversationRosterAgent = {
  handle: string;
  displayName: string;
  avatarSeed: string;
};

/**
 * Resolves the humans shown in the conversation roster from the same
 * population `resolveConversationHumanPeerContext` inspects: conversation
 * participants plus, for public conversations, project and org members. The
 * current user always leads the list so "who is in this room" starts with
 * "you". Returns an empty list while the peer directories are still loading
 * or errored (`humanPeerContext.resolved === false`) so the roster never
 * flashes a partial room.
 */
export function resolveConversationRosterHumans({
  conversationVisibility,
  currentUserId,
  humanLabelByUserId,
  humanPeerContext,
  orgMembers,
  participants,
  projectMembers,
}: {
  conversationVisibility: "public" | "private" | null;
  currentUserId: string | null;
  humanLabelByUserId: ReadonlyMap<string, string>;
  humanPeerContext: ConversationHumanPeerPresence | null | undefined;
  orgMembers: readonly RosterHumanSourceMember[];
  participants: readonly RosterHumanSourceMember[];
  projectMembers: readonly RosterHumanSourceMember[];
}): ConversationRosterHuman[] {
  if (!humanPeerContext?.resolved) {
    return [];
  }

  const normalizedCurrentUserId = currentUserId?.trim() ?? "";
  const humans: ConversationRosterHuman[] = [];
  const seen = new Set<string>();
  const append = (rawUserId: string) => {
    const userId = rawUserId.trim();
    if (!userId || seen.has(userId)) {
      return;
    }
    seen.add(userId);
    const isSelf = userId === normalizedCurrentUserId;
    humans.push({
      userId,
      label: humanLabelByUserId.get(userId) ?? (isSelf ? "You" : "Teammate"),
      isSelf,
    });
  };

  if (normalizedCurrentUserId) {
    append(normalizedCurrentUserId);
  }
  for (const participant of participants) {
    append(participant.userId);
  }
  if (conversationVisibility === "public") {
    for (const member of projectMembers) {
      append(member.userId);
    }
    for (const member of orgMembers) {
      append(member.userId);
    }
  }

  return humans;
}

/**
 * Multi-human conversations always show the roster; a single-human
 * conversation shows it only when at least one AI participant is active (a
 * solo chat with Octo shows just the two of you). An empty humans list means
 * the peer directories have not resolved yet, so nothing is shown.
 */
export function shouldShowConversationRoster({
  agents,
  humans,
}: {
  agents: readonly ConversationRosterAgent[];
  humans: readonly ConversationRosterHuman[];
}): boolean {
  if (humans.length === 0) {
    return false;
  }
  if (humans.length > 1) {
    return true;
  }
  return agents.length > 0;
}
