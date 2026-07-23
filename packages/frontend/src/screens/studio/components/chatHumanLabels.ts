import type { ControllerConversationParticipant } from "../../../sdk/instafy";

export type HumanLabelDirectoryEntry = {
  userId?: string | null;
  email?: string | null;
  fullName?: string | null;
};

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveDirectoryLabel(member: HumanLabelDirectoryEntry): string {
  const email = normalizeText(member.email);
  const fullName = normalizeText(member.fullName);
  if (email.toLowerCase().startsWith("guest+")) {
    return "Guest";
  }
  // A transcript is not a member-directory surface. Do not expose an email as
  // a chat identity when the person has not chosen a display name.
  return fullName || "Teammate";
}

function resolveParticipantFallback(
  participant: ControllerConversationParticipant,
): string {
  return participant.role.trim().toLowerCase() === "owner" ? "Owner" : "Teammate";
}

export function buildHumanLabelByUserId({
  directoryMembers,
  conversationParticipants,
}: {
  directoryMembers: readonly HumanLabelDirectoryEntry[];
  conversationParticipants: readonly ControllerConversationParticipant[];
}): Map<string, string> {
  const labels = new Map<string, string>();

  for (const member of directoryMembers) {
    const userId = normalizeText(member.userId);
    if (!userId) {
      continue;
    }
    labels.set(userId, resolveDirectoryLabel(member));
  }

  for (const participant of conversationParticipants) {
    const userId = normalizeText(participant.userId);
    const displayName = normalizeText(participant.displayName);
    if (!userId) {
      continue;
    }
    labels.set(
      userId,
      displayName || resolveParticipantFallback(participant),
    );
  }

  return labels;
}
