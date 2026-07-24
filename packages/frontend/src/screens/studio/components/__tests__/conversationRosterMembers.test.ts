import { describe, expect, it } from "vitest";
import {
  resolveConversationRosterHumans,
  shouldShowConversationRoster,
  type ConversationRosterAgent,
} from "../conversationRosterMembers";

const OCTO_AGENT: ConversationRosterAgent = {
  handle: "octo",
  displayName: "Octo",
  avatarSeed: "octo",
};

function createInput(
  overrides: Partial<Parameters<typeof resolveConversationRosterHumans>[0]> = {},
): Parameters<typeof resolveConversationRosterHumans>[0] {
  return {
    conversationVisibility: "private",
    currentUserId: "user-self",
    humanLabelByUserId: new Map<string, string>(),
    humanPeerContext: { hasHumanPeer: false, resolved: true },
    orgMembers: [],
    participants: [],
    projectMembers: [],
    ...overrides,
  };
}

describe("resolveConversationRosterHumans", () => {
  it("returns no humans while the peer directories are unresolved", () => {
    expect(
      resolveConversationRosterHumans(
        createInput({
          humanPeerContext: { hasHumanPeer: false, resolved: false },
          participants: [{ userId: "user-peer" }],
        }),
      ),
    ).toEqual([]);
    expect(
      resolveConversationRosterHumans(createInput({ humanPeerContext: null })),
    ).toEqual([]);
  });

  it("lists the current user first, then participant peers", () => {
    const humans = resolveConversationRosterHumans(
      createInput({
        humanLabelByUserId: new Map([
          ["user-self", "Marcus"],
          ["user-peer", "Ada"],
        ]),
        humanPeerContext: { hasHumanPeer: true, resolved: true },
        participants: [{ userId: "user-peer" }, { userId: "user-self" }],
      }),
    );

    expect(humans).toEqual([
      { userId: "user-self", label: "Marcus", isSelf: true },
      { userId: "user-peer", label: "Ada", isSelf: false },
    ]);
  });

  it("falls back to Teammate for peers without a display name and You for self", () => {
    const humans = resolveConversationRosterHumans(
      createInput({
        humanPeerContext: { hasHumanPeer: true, resolved: true },
        participants: [{ userId: "user-peer" }],
      }),
    );

    expect(humans).toEqual([
      { userId: "user-self", label: "You", isSelf: true },
      { userId: "user-peer", label: "Teammate", isSelf: false },
    ]);
  });

  it("includes project and org members only for public conversations", () => {
    const base = {
      humanPeerContext: { hasHumanPeer: true, resolved: true },
      participants: [{ userId: "user-peer" }],
      projectMembers: [{ userId: "user-project" }],
      orgMembers: [{ userId: "user-org" }],
    } as const;

    const publicHumans = resolveConversationRosterHumans(
      createInput({ ...base, conversationVisibility: "public" }),
    );
    expect(publicHumans.map((human) => human.userId)).toEqual([
      "user-self",
      "user-peer",
      "user-project",
      "user-org",
    ]);

    const privateHumans = resolveConversationRosterHumans(
      createInput({ ...base, conversationVisibility: "private" }),
    );
    expect(privateHumans.map((human) => human.userId)).toEqual([
      "user-self",
      "user-peer",
    ]);
  });

  it("dedupes members that appear in multiple directories", () => {
    const humans = resolveConversationRosterHumans(
      createInput({
        conversationVisibility: "public",
        humanPeerContext: { hasHumanPeer: true, resolved: true },
        participants: [{ userId: "user-peer" }, { userId: "user-self" }],
        projectMembers: [{ userId: "user-peer" }, { userId: "user-self" }],
        orgMembers: [{ userId: "user-peer" }],
      }),
    );

    expect(humans.map((human) => human.userId)).toEqual(["user-self", "user-peer"]);
  });
});

describe("shouldShowConversationRoster", () => {
  it("hides the roster while humans are unresolved", () => {
    expect(shouldShowConversationRoster({ agents: [OCTO_AGENT], humans: [] })).toBe(false);
  });

  it("hides the roster for a solo human with no active AI", () => {
    expect(
      shouldShowConversationRoster({
        agents: [],
        humans: [{ userId: "user-self", label: "You", isSelf: true }],
      }),
    ).toBe(false);
  });

  it("shows the roster for a solo human once an AI is active", () => {
    expect(
      shouldShowConversationRoster({
        agents: [OCTO_AGENT],
        humans: [{ userId: "user-self", label: "You", isSelf: true }],
      }),
    ).toBe(true);
  });

  it("always shows the roster for multi-human conversations", () => {
    expect(
      shouldShowConversationRoster({
        agents: [],
        humans: [
          { userId: "user-self", label: "You", isSelf: true },
          { userId: "user-peer", label: "Ada", isSelf: false },
        ],
      }),
    ).toBe(true);
  });
});
