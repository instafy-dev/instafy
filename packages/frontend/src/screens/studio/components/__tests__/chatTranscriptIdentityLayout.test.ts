import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { resolveChatTranscriptIdentityLayout } from "../chatTranscriptIdentityLayout";

// The viewer's own saved Octo. The controller answers this person with it and
// stamps its id on each reply and run; the rail lists it once the viewer's
// agents load.
const OWN_OCTO_ID = "6f0c2d5e-1b7a-4c3e-9a51-7d2e8b4f0a13";
// Another member's Octo: the same handle, an id of its own.
const OTHER_OCTO_ID = "0b9e4c71-52d8-4f6a-8e3b-c4a7d1f29e65";
const ownOctoStamp = { id: OWN_OCTO_ID, handle: "octo", avatarSeed: "octo", displayName: "Octo" };
const railOcto = { handle: "octo", agentId: OWN_OCTO_ID, avatarSeed: "octo" };

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message",
  role: "assistant",
  content: "Here is the comparison.",
  timestamp: 1,
  metadata: { agent: { handle: "octo", avatarSeed: "octo" } },
  ...overrides,
});

const prompt = message({ id: "prompt", role: "user", authorId: "self", metadata: null });

function input(overrides: Partial<Parameters<typeof resolveChatTranscriptIdentityLayout>[0]> = {}) {
  return {
    currentUserId: "self",
    chatClientSessionId: "local-session",
    humanPeerContext: { resolved: true, hasHumanPeer: false },
    rosterAgents: [railOcto],
    historyComplete: true,
    messages: [prompt, message()],
    runAgentIdentityByRunId: new Map(),
    runMetadata: [],
    ...overrides,
  } satisfies Parameters<typeof resolveChatTranscriptIdentityLayout>[0];
}

describe("resolveChatTranscriptIdentityLayout", () => {
  it("uses solo layout for a resolved one-human conversation with only built-in Octo", () => {
    expect(resolveChatTranscriptIdentityLayout(input())).toBe("solo");
    expect(resolveChatTranscriptIdentityLayout(input({ rosterAgents: [{ ...railOcto, handle: " Octo " }, railOcto] }))).toBe("solo");
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [] }))).toBe("solo");
    // Before the viewer's agents load, the rail knows Octo by handle alone.
    expect(resolveChatTranscriptIdentityLayout(input({ rosterAgents: [{ handle: "octo", agentId: null, avatarSeed: "octo" }] }))).toBe("solo");
  });

  it("uses solo layout when every reply and run carries the id of the rail's Octo", () => {
    const replies = [
      prompt,
      message({ id: "reply-one", metadata: { runId: "run-one", agent: ownOctoStamp } }),
      // A reply stamped only with its run is that run's agent.
      message({ id: "reply-two", metadata: { runId: "run-two" } }),
      // Rows from before replies carried an id stay the built-in Octo.
      message({ id: "older-reply" }),
    ];
    expect(resolveChatTranscriptIdentityLayout(input({
      messages: replies,
      runAgentIdentityByRunId: new Map([
        ["run-one", { id: OWN_OCTO_ID, handle: "octo", avatarSeed: "octo" }],
        ["run-two", { id: OWN_OCTO_ID, handle: "octo", avatarSeed: "octo" }],
      ]),
      runMetadata: [{ agent: ownOctoStamp }],
    }))).toBe("solo");
  });

  it("goes by the rail's current face for the viewer's own Octo, as the chat draws its rows", () => {
    // Removing Octo's picture resets its seed to its id, which is Octo's tile
    // again. Replies stamped while it wore the picture are drawn from the
    // current profile too.
    expect(resolveChatTranscriptIdentityLayout(input({
      rosterAgents: [{ ...railOcto, avatarSeed: OWN_OCTO_ID }],
      messages: [
        prompt,
        message({ id: "while-pictured", metadata: { agent: { ...ownOctoStamp, avatarSeed: "/avatars/octo-photo.png" } } }),
        message({ id: "after", metadata: { agent: { ...ownOctoStamp, avatarSeed: OWN_OCTO_ID } } }),
      ],
    }))).toBe("solo");
  });

  it.each([
    { currentUserId: null },
    { humanPeerContext: null },
    { humanPeerContext: { resolved: false, hasHumanPeer: false } },
    { humanPeerContext: { resolved: true, hasHumanPeer: true } },
    { historyComplete: false },
    { rosterAgents: [] },
    { rosterAgents: [{ handle: "reviewer", agentId: "reviewer-agent", avatarSeed: "hatchling:2" }] },
    { rosterAgents: [railOcto, { handle: "reviewer", agentId: "reviewer-agent", avatarSeed: "hatchling:2" }] },
    { rosterAgents: [railOcto, { ...railOcto, agentId: OTHER_OCTO_ID }] },
  ])("keeps identities while membership or complete history cannot establish solo: %j", overrides => {
    expect(resolveChatTranscriptIdentityLayout(input(overrides))).toBe("participants");
  });

  it("keeps a former human author identifiable after they leave the roster", () => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [
      message({ role: "user", authorId: "former-peer" }), message(),
    ] }))).toBe("participants");
  });

  it("keeps older messages without sender metadata conservative instead of assuming they are mine", () => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [
      message({ role: "user", authorId: null, metadata: null }), message(),
    ] }))).toBe("participants");
  });

  it("uses existing optimistic-message ownership and legacy built-in assistant semantics", () => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [
      message({ role: "user", metadata: { client: { userId: "self", sessionId: "local-session" } } }),
      message({ metadata: null }),
    ] }))).toBe("solo");
  });

  it("does not treat a browser hand-back notice as an unknown human message", () => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [
      message({ role: "user", authorId: null, metadata: { browserHandBack: { browserJobId: "browser-job" } } }),
      message(),
    ] }))).toBe("solo");
  });

  it.each([
    { handle: "reviewer", avatarSeed: "reviewer" },
    // The rail's handle on an id the rail does not list: another member's Octo.
    { handle: "octo", id: OTHER_OCTO_ID, avatarSeed: "octo" },
    { handle: "octo", avatarSeed: "different-observed-face" },
    { id: "unknown-agent" },
  ])("preserves observed agents rather than treating a matching handle as the rail's Octo: %j", agent => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [message({ metadata: { agent } })] }))).toBe("participants");
  });

  it("keeps participant identity when two different ids share Octo's handle", () => {
    const mine = message({ id: "mine", metadata: { agent: ownOctoStamp } });
    const theirs = message({ id: "theirs", metadata: { agent: { ...ownOctoStamp, id: OTHER_OCTO_ID } } });
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [prompt, mine, theirs] }))).toBe("participants");
    // The same holds when only a run names the other Octo.
    expect(resolveChatTranscriptIdentityLayout(input({
      messages: [prompt, mine, message({ id: "their-run-reply", metadata: { runId: "their-run" } })],
      runAgentIdentityByRunId: new Map([["their-run", { id: OTHER_OCTO_ID, handle: "octo", avatarSeed: "octo" }]]),
    }))).toBe("participants");
    expect(resolveChatTranscriptIdentityLayout(input({
      messages: [prompt, mine],
      runMetadata: [{ agent: { ...ownOctoStamp, id: OTHER_OCTO_ID } }],
    }))).toBe("participants");
  });

  it("does not trust an Octo id before the rail knows which Octo is the viewer's", () => {
    expect(resolveChatTranscriptIdentityLayout(input({
      rosterAgents: [{ handle: "octo", agentId: null, avatarSeed: "octo" }],
      messages: [prompt, message({ metadata: { agent: ownOctoStamp } })],
    }))).toBe("participants");
  });

  it.each([
    "https://cdn.example.test/octo-photo.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "hatchling:3",
  ])("keeps participant identity while the rail's Octo wears %s rather than its tile", avatarSeed => {
    for (const messages of [
      [prompt, message()],
      [prompt, message({ metadata: { agent: ownOctoStamp } })],
    ]) {
      expect(resolveChatTranscriptIdentityLayout(input({ rosterAgents: [{ ...railOcto, avatarSeed }], messages }))).toBe("participants");
    }
  });

  it("keeps an agent known through run metadata even when the message has no agent stamp", () => {
    expect(resolveChatTranscriptIdentityLayout(input({
      messages: [message({ metadata: { runId: "old-run" } })],
      runAgentIdentityByRunId: new Map([["old-run", { id: "old-agent", handle: "reviewer", avatarSeed: "old-agent" }]]),
    }))).toBe("participants");
  });

  it("does not assume an unresolved historical run was authored by Octo", () => {
    expect(resolveChatTranscriptIdentityLayout(input({
      messages: [message({ metadata: { runId: "unloaded-old-run" } })],
    }))).toBe("participants");
  });

  it("preserves an active worker that has not written its first message yet", () => {
    expect(resolveChatTranscriptIdentityLayout(input({
      runMetadata: [{ agent: { handle: "reviewer", id: "worker" } }],
    }))).toBe("participants");
  });

  it.each([
    { multiAgentPlan: { groupId: "plan", role: "lead" } },
    { multi_agent_plan: { groupId: "plan", role: "lead" } },
    { threadMessages: [message({ metadata: { agent: { handle: "reviewer" } } })] },
    // A plan's lead stamped as the rail's own Octo still leads helpers.
    { agent: ownOctoStamp, multiAgentPlan: { groupId: "plan", role: "lead" } },
  ])("keeps participant identity for nested jobs and plans: %j", metadata => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [message({ metadata })] }))).toBe("participants");
  });

  it.each(["multi_agent_plan", "agent_job_thread"])("keeps %s participant identity before nested rows or workers arrive", messageType => {
    // Both raw message kinds and the legacy metadata spelling are rendered
    // as plan/thread entries; neither proves that only Octo authored them.
    for (const entry of [
      message({ messageType }),
      message({ metadata: { message_type: messageType, agent: { handle: "octo" }, details: {} } }),
      message({ metadata: { message_type: messageType, agent: ownOctoStamp, details: {} } }),
    ]) {
      expect(resolveChatTranscriptIdentityLayout(input({ messages: [entry] }))).toBe("participants");
    }
  });
});
