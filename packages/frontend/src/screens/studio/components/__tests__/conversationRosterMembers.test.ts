import { describe, expect, it } from "vitest";
import { resolveAiFace } from "../../../../utils/aiFace";
import {
  resolveConversationRosterAgents,
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
          ["user-self", "Taylor"],
          ["user-peer", "Ada"],
        ]),
        humanPeerContext: { hasHumanPeer: true, resolved: true },
        participants: [{ userId: "user-peer" }, { userId: "user-self" }],
      }),
    );

    expect(humans).toEqual([
      { userId: "user-self", label: "Taylor", isSelf: true },
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

describe("resolveConversationRosterAgents", () => {
  const ownBuild = { id: "own-bot", handle: "build", displayName: "My build bot", avatarSeed: "hatchling:8" };
  const face = (agent: ConversationRosterAgent | undefined) =>
    resolveAiFace({ handle: agent?.handle, avatarSeed: agent?.avatarSeed, agentId: agent?.agentId, textOnly: agent?.textOnly });

  it("draws the viewer's own saved agent as its profile has it, once per handle", () => {
    const agents = resolveConversationRosterAgents({
      agentHandles: ["build", " BUILD "],
      agentByHandle: new Map([["build", ownBuild]]),
    });
    expect(agents).toEqual([
      { handle: "build", displayName: "My build bot", avatarSeed: "hatchling:8", agentId: "own-bot" },
    ]);
    expect(face(agents[0])).toEqual({ kind: "hatchling", n: 8, reason: "stamp" });
  });

  it("draws a handle the viewer has no saved agent for with the hollow face, as the mention picker does", () => {
    // Not the handle's hash (kimbot is 2): nothing the Studio has says which
    // face the AI's rows wear.
    const [kimbot] = resolveConversationRosterAgents({ agentHandles: ["kimbot"], agentByHandle: new Map() });
    expect(kimbot).toMatchObject({ handle: "kimbot", displayName: "@kimbot", agentId: null, textOnly: true });
    expect(face(kimbot)).toEqual({ kind: "unknown" });
    expect(resolveAiFace({ handle: "kimbot" })).toMatchObject({ kind: "hatchling", n: 2 });
    // Octo is Octo all the same.
    const [octo] = resolveConversationRosterAgents({ agentHandles: ["octo"], agentByHandle: new Map() });
    expect(octo).toMatchObject({ displayName: "Octo", textOnly: true });
    expect(face(octo)).toEqual({ kind: "octo" });
  });
});
