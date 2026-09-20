import { describe, expect, it } from "vitest";
import type { ControllerProjectMember } from "../../../../sdk/instafy";
import { mergeMentionableMembers } from "../mentionableMembers";

function member(userId: string, fullName: string): ControllerProjectMember {
  return { userId, fullName, email: `${userId}@example.test` } as ControllerProjectMember;
}

describe("mergeMentionableMembers", () => {
  it("counts an org teammate even when the project itself lists only the viewer", () => {
    // The gate's "turn the assistant off" caption keys on this set, so an
    // org-shared space with one extra org member has teammates.
    const result = mergeMentionableMembers({
      orgMembers: [member("me", "Me"), member("org-1", "Ada")],
      projectMembers: [member("me", "Me")],
      currentUserId: "me",
    });
    expect(result.map((entry) => entry.userId)).toEqual(["org-1"]);
    expect(result.length > 0).toBe(true);
  });

  it("yields nobody when the viewer is the only member anywhere", () => {
    const result = mergeMentionableMembers({
      orgMembers: [member("me", "Me")],
      projectMembers: [member("me", "Me")],
      currentUserId: "me",
    });
    expect(result).toEqual([]);
  });

  it("de-duplicates across org and project and sorts by name", () => {
    const result = mergeMentionableMembers({
      orgMembers: [member("b", "Zed"), member("a", "Ada")],
      projectMembers: [member("a", "Ada"), member("c", "Mia"), { userId: " " } as ControllerProjectMember],
      currentUserId: null,
    });
    expect(result.map((entry) => entry.fullName)).toEqual(["Ada", "Mia", "Zed"]);
  });
});
