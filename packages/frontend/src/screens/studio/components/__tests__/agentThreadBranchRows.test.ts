import { describe, expect, it } from "vitest";

import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import { resolveAiFace } from "../../../../utils/aiFace";
import type { ChatMessage } from "../../types";
import {
  buildAgentThreadBranchRows,
  collectReferencedThreadTargets,
  shouldHideStandaloneConversationThreadPreview,
  type AgentThreadBranchParticipant,
} from "../agentThreadBranchRows";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

function createConversation(overrides: Partial<ConversationState>): ConversationState {
  return {
    localId: "thread-local",
    title: "Child thread",
    visibility: "public",
    lifecycleStatus: "active",
    controllerId: "thread-controller",
    parentConversationId: "parent-controller",
    threadKind: "agent",
    ownerAgent: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: true,
    extraAgentHandles: [],
    unreadCount: 0,
    createdAt: 1_000,
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
    activeGoal: overrides.activeGoal ?? null,
  };
}

describe("agentThreadBranchRows", () => {
  it("collects thread refs from agent run thread messages", () => {
    const targets = collectReferencedThreadTargets([
      createMessage({
        messageType: "agent_job_thread",
        metadata: {
          messageType: "agent_job_thread",
          threadMessages: [
            createMessage({
              id: "summary",
              content: "See [[thread:thread-controller|Preview cleanup smoke]].",
            }),
          ],
        },
      }),
    ]);

    expect(Array.from(targets)).toEqual(["thread-controller"]);
  });

  it("hides standalone child thread cards when empty or already referenced", () => {
    const emptyThread = createConversation({ messages: [] });
    const referencedThread = createConversation({
      localId: "referenced-local",
      controllerId: "referenced-controller",
      messages: [createMessage({ id: "seed", role: "user", content: "@ben What is 6+7?" })],
    });
    const preview = createMessage({
      messageType: "conversation_thread",
      metadata: { messageType: "conversation_thread", threadLocalId: "thread-local" },
    });

    expect(
      shouldHideStandaloneConversationThreadPreview({
        thread: emptyThread,
        preview,
        referencedThreadTargets: new Set(),
      }),
    ).toBe(true);
    expect(
      shouldHideStandaloneConversationThreadPreview({
        thread: referencedThread,
        preview,
        referencedThreadTargets: new Set(["referenced-controller"]),
      }),
    ).toBe(true);
  });

  it("builds compact branch rows with participants, count, and running state", () => {
    const childThread = createConversation({
      localId: "child-local",
      controllerId: "child-controller",
      title: "Preview cleanup smoke",
      ownerAgent: { id: "agent-octo", handle: "octo" },
      pendingRunIds: ["run-1"],
      messages: [
        createMessage({ id: "seed", role: "user", content: "@ben What is 6+7?" }),
        createMessage({
          id: "reply",
          role: "assistant",
          content: "13",
          metadata: { agent: { handle: "ben", avatarSeed: "ben" } },
        }),
      ],
    });
    const runThread = createMessage({
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        threadMessages: [
          createMessage({
            id: "summary",
            content: "Opened [[thread:child-controller|Preview cleanup smoke]].",
          }),
        ],
      },
    });

    expect(buildAgentThreadBranchRows({ message: runThread, conversations: [childThread] })).toEqual([
      {
        threadLocalId: "child-local",
        title: "Preview cleanup smoke",
        hiddenActivityCount: 2,
        isRunning: true,
        participants: [
          // The owner goes first. Nothing in the thread is stamped with its id
          // yet, so it is known only by name: Octo is Octo all the same.
          { handle: "octo", agentId: "agent-octo", textOnly: true },
          { handle: "ben", avatarSeed: "ben", avatarUrl: null, agentId: null, displayName: null },
        ],
      },
    ]);
  });

  it("takes branch faces only from stamped agents, never from @words in the text", () => {
    // A person's mention is written @kim, and @types/node or an email's
    // @example are not participants at all. The stack draws every participant
    // as an AI tile, so a text scan would turn Kim into an AI.
    const childThread = createConversation({
      localId: "child-local",
      controllerId: "child-controller",
      title: "Package check",
      ownerAgent: { id: "agent-octo", handle: "octo" },
      messages: [
        createMessage({
          id: "ask",
          role: "user",
          content: "@kim can you check @types/node? Mail kim@example.com if it breaks.",
        }),
        createMessage({
          id: "reply",
          role: "assistant",
          content: "@kim the types build. Ran `pnpm --filter @instafy/frontend test`.",
          metadata: { agent: { handle: "octo", avatarSeed: "octo" } },
        }),
      ],
    });
    const runThread = createMessage({
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        threadMessages: [createMessage({ id: "summary", content: "Opened [[thread:child-controller|Package check]]." })],
      },
    });

    const [row] = buildAgentThreadBranchRows({ message: runThread, conversations: [childThread] });
    // Octo's own row, stamped without an id, is the owner's: one entry.
    expect(row?.participants).toEqual([
      { handle: "octo", agentId: "agent-octo", avatarSeed: "octo", avatarUrl: null, displayName: null },
    ]);
  });

  function participantsOf(thread: Partial<ConversationState>, savedAgents?: ReadonlyMap<string, { avatarSeed: string }>) {
    const childThread = createConversation({ localId: "child-local", controllerId: "child-controller", ...thread });
    const runThread = createMessage({
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        threadMessages: [createMessage({ id: "summary", content: "Opened [[thread:child-controller|Child]]." })],
      },
    });
    const [row] = buildAgentThreadBranchRows({ message: runThread, conversations: [childThread], savedAgents });
    return row?.participants ?? [];
  }
  const face = (participant: AgentThreadBranchParticipant | undefined) => resolveAiFace(participant ?? {});
  const reply = (id: string, agent: Record<string, unknown>, overrides: Partial<ChatMessage> = {}) =>
    createMessage({ id, role: "assistant", content: "Done.", metadata: { agent }, ...overrides });

  it("takes faces only from what an AI wrote, never from a person's row", () => {
    // A member's client can copy an agent onto the member's own message, and
    // a runtime alert a person raised is theirs.
    const participants = participantsOf({
      messages: [
        createMessage({ id: "ask", role: "user", content: "Please", metadata: { agent: { handle: "forged", avatarSeed: "hatchling:1" } } }),
        reply("alert", { handle: "alerter", avatarSeed: "hatchling:2" }, { authorId: "user-1", messageType: "runtime_alert" }),
        reply("answer", { handle: "ben", avatarSeed: "hatchling:3" }),
        reply("status", { handle: "status-bot", avatarSeed: "hatchling:4" }, { messageType: "status" }),
      ],
    });
    expect(participants.map((participant) => participant.handle)).toEqual(["ben", "status-bot"]);
  });

  it("keys each AI by its agent id, else its handle and stamp", () => {
    const participants = participantsOf({
      messages: [
        // Two helpers of two plans, both named reviewer, wearing two faces.
        reply("a", { handle: "reviewer", avatarSeed: "hatchling:2" }),
        reply("b", { handle: "reviewer", avatarSeed: "hatchling:5" }),
        reply("a-again", { handle: "reviewer", avatarSeed: "hatchling:2" }),
        // One saved agent, renamed between its rows.
        reply("pia", { handle: "pia", id: "agent-pia", avatarSeed: "hatchling:6" }),
        reply("pia-renamed", { handle: "pia-2", id: "agent-pia", avatarSeed: "hatchling:6" }),
      ],
    });
    expect(participants.map((participant) => [participant.handle, participant.avatarSeed])).toEqual([
      ["reviewer", "hatchling:2"],
      ["reviewer", "hatchling:5"],
      ["pia", "hatchling:6"],
    ]);
  });

  it("gives the owner the face its own rows wear: its picture, or its stamp", () => {
    // A saved owner's rows carry its id; its first one decides.
    const pictured = participantsOf({
      ownerAgent: { id: "agent-pia", handle: "pia" },
      messages: [
        reply("helper", { handle: "ben", avatarSeed: "hatchling:3" }),
        reply("pia", { handle: "pia", id: "agent-pia", avatarSeed: "https://images.example/pia.png" }),
      ],
    });
    expect(pictured.map((participant) => participant.handle)).toEqual(["pia", "ben"]);
    expect(face(pictured[0])).toMatchObject({ kind: "picture", src: "https://images.example/pia.png" });
    // A helper owner has no id: its rows are the ones with its handle.
    const helper = participantsOf({
      ownerAgent: { id: null, handle: "reading_list" },
      messages: [reply("first", { handle: "reading_list", avatarSeed: "hatchling:4" })],
    });
    expect(helper).toHaveLength(1);
    expect(face(helper[0])).toEqual({ kind: "hatchling", n: 4, reason: "stamp" });
  });

  it("matches an owner named by its handle alone to its own rows, which carry its id", () => {
    // The Studio writes a thread's owner as { id: null, handle }, while a
    // saved agent's rows, and Octo's, carry the agent's id.
    const saved = participantsOf({
      ownerAgent: { id: null, handle: "build" },
      messages: [
        createMessage({ id: "ask", role: "user", content: "@build fix it" }),
        reply("first", { handle: "build", id: "agent-build", avatarSeed: "hatchling:6" }),
        reply("again", { handle: "build", id: "agent-build", avatarSeed: "hatchling:6" }),
        // Another AI that shares the handle is another participant.
        reply("other", { handle: "build", id: "agent-other", avatarSeed: "hatchling:2" }),
      ],
    });
    expect(saved.map((participant) => [participant.handle, participant.agentId])).toEqual([
      ["build", "agent-build"],
      ["build", "agent-other"],
    ]);
    expect(face(saved[0])).toEqual({ kind: "hatchling", n: 6, reason: "stamp" });
    const octo = participantsOf({
      ownerAgent: { id: null, handle: "octo" },
      messages: [reply("hi", { handle: "octo", id: "agent-octo", avatarSeed: "agent-octo" })],
    });
    expect(octo).toHaveLength(1);
    expect(face(octo[0])).toEqual({ kind: "octo" });
  });

  it("draws an owner named by its handle alone, before its first row, as the viewer's saved agent with that handle", () => {
    const unstamped = { ownerAgent: { id: null, handle: "pia" }, messages: [] };
    const savedAgents = new Map([["agent-pia", { avatarSeed: "hatchling:8", handle: "pia" }]]);
    const [owner] = participantsOf(unstamped, savedAgents);
    expect(owner).toMatchObject({ handle: "pia", agentId: "agent-pia" });
    expect(face(owner)).toEqual({ kind: "hatchling", n: 8, reason: "stamp" });
    // Without one, it is known only by name.
    expect(face(participantsOf(unstamped)[0])).toEqual({ kind: "unknown" });
    expect(face(participantsOf(unstamped, new Map([["agent-ben", { avatarSeed: "hatchling:3", handle: "ben" }]]))[0]))
      .toEqual({ kind: "unknown" });
  });

  it("draws an owner with no stamp yet as known only by name, unless the viewer saved it", () => {
    const unstamped = { ownerAgent: { id: "agent-pia", handle: "pia" }, messages: [] };
    expect(face(participantsOf(unstamped)[0])).toEqual({ kind: "unknown" });
    // The viewer's own saved agent wears its current profile, here and on
    // every row it wrote.
    const savedAgents = new Map([["agent-pia", { avatarSeed: "hatchling:8" }]]);
    expect(face(participantsOf(unstamped, savedAgents)[0])).toEqual({ kind: "hatchling", n: 8, reason: "stamp" });
    const stamped = participantsOf({
      ownerAgent: { id: "agent-pia", handle: "pia" },
      messages: [reply("old", { handle: "pia", id: "agent-pia", avatarSeed: "hatchling:2" })],
    }, savedAgents);
    expect(face(stamped[0])).toMatchObject({ kind: "hatchling", n: 8 });
  });
});
