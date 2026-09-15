import { describe, expect, it } from "vitest";
import { getDefaultAssistantHandle } from "../../../../assistants/localBuiltInAssistantCatalog";
import type { ConversationState } from "../../../../conversations/conversationState";
import type { RunRecord } from "../../../../types";
import {
  AGENT_ACTIVITY_MAX_ROWS,
  deriveAgentConversationActivity,
} from "../agentConversationActivity";

const NOW = Date.parse("2026-08-30T12:00:00Z");

function makeConversation(
  overrides: Partial<ConversationState>,
): ConversationState {
  return {
    localId: "local-1",
    title: "A conversation",
    visibility: "public",
    lifecycleStatus: "active",
    controllerId: null,
    parentConversationId: null,
    threadKind: null,
    ownerAgent: null,
    activeGoal: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: false,
    extraAgentHandles: [],
    unreadCount: 0,
    createdAt: NOW - 60_000,
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-1",
    projectId: "project-1",
    sessionId: null,
    conversationId: null,
    promptId: null,
    runType: "prompt",
    status: "in_progress",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: { agent: { handle: "scout" } },
    createdAt: new Date(NOW - 30_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  };
}

function derive(
  conversations: ConversationState[],
  runs: RunRecord[] = [],
  options: { agentHandle?: string; agentId?: string | null } = {},
) {
  return deriveAgentConversationActivity({
    agentHandle: options.agentHandle ?? "scout",
    agentId: options.agentId ?? null,
    conversations,
    runs: Object.fromEntries(runs.map((run) => [run.id, run])),
    now: NOW,
  });
}

describe("deriveAgentConversationActivity", () => {
  it("keeps activity separate for two owners with the same bot handle", () => {
    const activity = derive([
      makeConversation({ localId: "peer-owned", ownerAgent: { id: "peer-bot", handle: "scout" } }),
      makeConversation({ localId: "own-owned", ownerAgent: { id: "own-bot", handle: "scout" } }),
      makeConversation({ localId: "handle-only", extraAgentHandles: ["scout"] }),
      makeConversation({ localId: "peer-run", controllerId: "peer-conversation" }),
      makeConversation({ localId: "own-run", controllerId: "own-conversation" }),
      makeConversation({ localId: "legacy-run", controllerId: "legacy-conversation" }),
      makeConversation({ localId: "peer-delegated", delegatedByAgentId: "peer-bot" }),
    ], [
      makeRun({ id: "peer", conversationId: "peer-conversation", metadata: { agent: { id: "peer-bot", handle: "scout-renamed" } } }),
      makeRun({ id: "own", conversationId: "own-conversation", metadata: { agent: { id: "own-bot", handle: "scout" } } }),
      makeRun({ id: "legacy", conversationId: "legacy-conversation" }),
    ], { agentId: "peer-bot" });
    expect(activity.entries.map((entry) => entry.localId).sort()).toEqual(["peer-delegated", "peer-owned", "peer-run"]);
    expect(activity.entries.find((entry) => entry.localId === "peer-run")?.workingNow).toBe(true);
  });

  it("keeps an exact owner's activity after its handle changes", () => {
    const activity = derive([
      makeConversation({ localId: "renamed", ownerAgent: { id: "peer-bot", handle: "old-handle" } }),
    ], [], { agentId: "peer-bot", agentHandle: "new-handle" });
    expect(activity.entries.map((entry) => entry.localId)).toEqual(["renamed"]);
  });
  it("lists threads the agent owns", () => {
    const activity = derive([
      makeConversation({
        localId: "owned",
        ownerAgent: { id: "agent-1", handle: "scout" },
      }),
      makeConversation({
        localId: "other",
        ownerAgent: { id: "x", handle: "someone" },
      }),
    ]);
    expect(activity.entries.map((entry) => entry.localId)).toEqual(["owned"]);
    expect(activity.entries[0]?.workingNow).toBe(false);
  });

  it("matches invited handles case-insensitively and with a leading @", () => {
    const activity = derive([
      makeConversation({ localId: "invited", extraAgentHandles: ["@Scout"] }),
    ]);
    expect(activity.entries.map((entry) => entry.localId)).toEqual(["invited"]);
  });

  it("never treats the default-on assistant toggle as participation", () => {
    // assistantEnabled defaults to true on every conversation — availability,
    // not interaction — so even the default assistant must not list on it.
    const conversations = [
      makeConversation({ localId: "default-on", assistantEnabled: true }),
    ];
    expect(derive(conversations).entries).toEqual([]);
    expect(
      derive(conversations, [], { agentHandle: getDefaultAssistantHandle() })
        .entries,
    ).toEqual([]);
  });

  it("lists the default assistant where it actually ran", () => {
    const activity = derive(
      [
        makeConversation({
          localId: "spoke-here",
          controllerId: "conv-a",
          assistantEnabled: true,
        }),
        makeConversation({ localId: "silent", assistantEnabled: true }),
      ],
      [
        makeRun({
          conversationId: "conv-a",
          metadata: { agent: { handle: getDefaultAssistantHandle() } },
        }),
      ],
      { agentHandle: getDefaultAssistantHandle() },
    );
    expect(activity.entries.map((entry) => entry.localId)).toEqual([
      "spoke-here",
    ]);
  });

  it("marks an actively-progressing run as working now and links by controller id", () => {
    const activity = derive(
      [makeConversation({ localId: "busy", controllerId: "conv-9" })],
      [makeRun({ conversationId: "conv-9" })],
    );
    expect(activity.entries).toEqual([
      {
        localId: "busy",
        title: "A conversation",
        isPrivate: false,
        workingNow: true,
      },
    ]);
  });

  it("still lists a conversation whose runs have finished, without the live flag", () => {
    const activity = derive(
      [makeConversation({ localId: "done", controllerId: "conv-9" })],
      [
        makeRun({
          conversationId: "conv-9",
          status: "completed" as RunRecord["status"],
        }),
      ],
    );
    expect(activity.entries.map((entry) => entry.workingNow)).toEqual([false]);
  });

  it("ignores runs attributed to other agents", () => {
    const activity = derive(
      [makeConversation({ localId: "other-agent", controllerId: "conv-9" })],
      [
        makeRun({
          conversationId: "conv-9",
          metadata: { agent: { handle: "rival" } },
        }),
      ],
    );
    expect(activity.entries).toEqual([]);
  });

  it("treats a long-stale in-progress run as not working", () => {
    const staleAt = new Date(NOW - 31 * 60 * 1000).toISOString();
    const activity = derive(
      [makeConversation({ localId: "stale", controllerId: "conv-9" })],
      [
        makeRun({
          conversationId: "conv-9",
          createdAt: staleAt,
          updatedAt: staleAt,
        }),
      ],
    );
    expect(activity.entries.map((entry) => entry.workingNow)).toEqual([false]);
  });

  it("keeps hidden and deleted conversations off the profile", () => {
    const activity = derive([
      makeConversation({
        localId: "hidden",
        lifecycleStatus: "hidden",
        ownerAgent: { id: "agent-1", handle: "scout" },
      }),
      makeConversation({
        localId: "deleted",
        lifecycleStatus: "deleted",
        ownerAgent: { id: "agent-1", handle: "scout" },
      }),
    ]);
    expect(activity.entries).toEqual([]);
  });

  it("flags private conversations the viewer can see", () => {
    const activity = derive([
      makeConversation({
        localId: "dm",
        visibility: "private",
        ownerAgent: { id: "agent-1", handle: "scout" },
      }),
    ]);
    expect(activity.entries[0]?.isPrivate).toBe(true);
  });

  it("puts live work first and reports the overflow beyond the cap", () => {
    const conversations = Array.from(
      { length: AGENT_ACTIVITY_MAX_ROWS + 2 },
      (_, index) =>
        makeConversation({
          localId: `c-${index}`,
          controllerId: `conv-${index}`,
          ownerAgent: { id: "agent-1", handle: "scout" },
          createdAt: NOW - index * 1000,
        }),
    );
    // The oldest conversation has the only live run — it must lead anyway.
    const activity = derive(conversations, [
      makeRun({ conversationId: `conv-${AGENT_ACTIVITY_MAX_ROWS + 1}` }),
    ]);
    expect(activity.entries).toHaveLength(AGENT_ACTIVITY_MAX_ROWS);
    expect(activity.entries[0]?.localId).toBe(
      `c-${AGENT_ACTIVITY_MAX_ROWS + 1}`,
    );
    expect(activity.entries[0]?.workingNow).toBe(true);
    expect(activity.overflowCount).toBe(2);
  });

  it("lists delegated threads when the agent id matches", () => {
    const conversations = [
      makeConversation({ localId: "delegated", delegatedByAgentId: "agent-1" }),
    ];
    expect(derive(conversations).entries).toEqual([]);
    expect(
      derive(conversations, [], { agentId: "agent-1" }).entries.map(
        (entry) => entry.localId,
      ),
    ).toEqual(["delegated"]);
  });
});
