import type { ControllerProjectMember } from "../../../sdk/instafy";

/**
 * The people a chat can mention: org members and project members merged,
 * de-duplicated by user id, without the viewer, sorted by name. ChatPanel
 * reads it for @-mentions and for whether the space has teammates at all
 * (the gate's "turn the assistant off" caption), so both agree.
 */
export function mergeMentionableMembers({
  orgMembers,
  projectMembers,
  currentUserId,
}: {
  orgMembers: readonly ControllerProjectMember[] | null | undefined;
  projectMembers: readonly ControllerProjectMember[] | null | undefined;
  currentUserId: string | null;
}): ControllerProjectMember[] {
  const merged = [...(orgMembers ?? []), ...(projectMembers ?? [])];
  const result: ControllerProjectMember[] = [];
  const seen = new Set<string>();
  for (const member of merged) {
    const userId = typeof member.userId === "string" ? member.userId.trim() : "";
    if (!userId || userId === currentUserId || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    result.push(member);
  }
  result.sort((a, b) => {
    const labelA = `${a.fullName ?? ""} ${a.email ?? ""}`.trim().toLowerCase();
    const labelB = `${b.fullName ?? ""} ${b.email ?? ""}`.trim().toLowerCase();
    return labelA.localeCompare(labelB);
  });
  return result;
}
