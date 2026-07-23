import { describe, expect, it } from "vitest";
import type { ControllerConversationParticipant } from "../../../../sdk/instafy";
import { buildHumanLabelByUserId } from "../chatHumanLabels";

function participant(
  userId: string,
  displayName?: string | null,
  role = "member",
): ControllerConversationParticipant {
  return {
    userId,
    displayName,
    role,
    addedBy: null,
    createdAt: "2026-07-16T12:00:00.000Z",
  };
}

describe("buildHumanLabelByUserId", () => {
  it("prefers conversation-safe display names over directory fallbacks", () => {
    const labels = buildHumanLabelByUserId({
      directoryMembers: [
        {
          userId: "guest-user",
          email: "guest+123@instafy.dev",
          fullName: null,
        },
        {
          userId: "org-user",
          email: "org@example.com",
          fullName: "Organization Name",
        },
      ],
      conversationParticipants: [
        participant("guest-user", "Project Guest"),
        participant("org-user", "Conversation Name"),
        participant("participant-only", "Visible Collaborator"),
      ],
    });

    expect(labels.get("guest-user")).toBe("Project Guest");
    expect(labels.get("org-user")).toBe("Conversation Name");
    expect(labels.get("participant-only")).toBe("Visible Collaborator");
  });

  it("uses scoped role fallbacks without exposing directory email addresses", () => {
    const labels = buildHumanLabelByUserId({
      directoryMembers: [
        {
          userId: "guest-user",
          email: "private-person@example.com",
          fullName: null,
        },
      ],
      conversationParticipants: [
        participant("guest-user", "   "),
        participant("unknown-user", null, "owner"),
      ],
    });

    expect(labels.get("guest-user")).toBe("Teammate");
    expect(labels.get("unknown-user")).toBe("Owner");
    expect([...labels.values()]).not.toContain("private-person@example.com");
  });
});
