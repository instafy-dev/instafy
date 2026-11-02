import { describe, expect, it } from "vitest";
import { aiFaceIdentityFromMetadata, resolveAiFace } from "../../../../utils/aiFace";
import type { ChatMessage } from "../../types";
import {
  areDistinctAgents,
  shouldShowAssistantAvatarForMessage,
  shouldShowAssistantIdentityForMessage,
  extractAgentIdentityFromMetadata,
  resolveObservedAgentIdentity,
  resolveTypingAgentLanes,
  resolveViewerAgentProfile,
} from "../chatAssistantIdentity";

function createAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "assistant-message",
    role: "assistant",
    authorId: null,
    content: "Answer",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: {
      agent: { handle: "octo", avatarSeed: "octo" },
    },
    ...overrides,
  };
}

describe("chatAssistantIdentity", () => {
  it("keeps exact observed IDs rather than identifying bots by handle", () => {
    expect(extractAgentIdentityFromMetadata({ agent: { id: " peer-bot ", handle: "@Build", avatarSeed: "peer-photo" } }))
      .toEqual({ id: "peer-bot", handle: "build", avatarSeed: "peer-photo" });
    expect(resolveObservedAgentIdentity(
      { handle: "build", avatarSeed: "display-photo" },
      { id: "peer-bot", handle: "build", avatarSeed: "metadata-photo" },
    )).toEqual({ id: "peer-bot", handle: "build", avatarSeed: "display-photo" });
    expect(resolveObservedAgentIdentity(
      { handle: "build", avatarSeed: "build" },
      { id: "other-bot", handle: "review", avatarSeed: "review" },
    )?.id).toBeUndefined();
  });
  it("keeps a stamped seed raw, and without one falls back to the agent id, else the handle", () => {
    // A face stamp is read raw, so no surface may trim one into existence.
    expect(extractAgentIdentityFromMetadata({ agent: { handle: "pia", avatarSeed: " hatchling:3" } })?.avatarSeed)
      .toBe(" hatchling:3");
    // The order the controller stamps a seed in (inject_agent_target_metadata).
    expect(extractAgentIdentityFromMetadata({ agent: { handle: "Pia", id: "agent-pia" } }))
      .toEqual({ handle: "pia", avatarSeed: "agent-pia", id: "agent-pia" });
    expect(extractAgentIdentityFromMetadata({ agent: { handle: "@Pia", avatarSeed: "  " } }))
      .toEqual({ handle: "pia", avatarSeed: "pia" });
    // So the gutter and label, which read the row through this, draw the
    // face the thread header and plan legend draw from the raw stamp.
    for (const agent of [
      { handle: "pia", avatarSeed: " hatchling:3" },
      { handle: "pia", id: "agent-pia" },
      { handle: "@Pia" },
      { handle: "pia", id: "agent-pia", avatarSeed: "hatchling:4" },
      { handle: "pia", id: "agent-pia", avatarSeed: "https://images.example/pia.png" },
    ]) {
      const identity = extractAgentIdentityFromMetadata({ agent })!;
      expect(resolveAiFace({ handle: identity.handle, avatarSeed: identity.avatarSeed, agentId: identity.id }), JSON.stringify(agent))
        .toEqual(resolveAiFace(aiFaceIdentityFromMetadata({ agent })!));
    }
  });

  it("keeps assistant avatars visible even when repeated identity labels are grouped", () => {
    const message = createAssistantMessage();

    expect(shouldShowAssistantIdentityForMessage(message, "octo")).toBe(false);
    expect(shouldShowAssistantAvatarForMessage(message)).toBe(true);
  });

  it("treats terminal runtime notices as verified-agent-owned while keeping neutral rows out", () => {
    expect(
      shouldShowAssistantAvatarForMessage(createAssistantMessage({ messageType: "agent_job_thread" })),
    ).toBe(false);
    expect(
      shouldShowAssistantAvatarForMessage(createAssistantMessage({ messageType: "runtime_alert" })),
    ).toBe(true);
    expect(
      shouldShowAssistantIdentityForMessage(
        createAssistantMessage({ messageType: "runtime_alert" }),
        "octo",
      ),
    ).toBe(true);
    const legacyNeutralRuntimeAlert = createAssistantMessage({
      messageType: "runtime_alert",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
      },
    });
    expect(shouldShowAssistantAvatarForMessage(legacyNeutralRuntimeAlert)).toBe(false);
    expect(
      shouldShowAssistantIdentityForMessage(legacyNeutralRuntimeAlert, "octo"),
    ).toBe(false);
    expect(
      shouldShowAssistantAvatarForMessage(createAssistantMessage({ messageType: "run_cancellation" })),
    ).toBe(false);
  });

  it("does not trust custom-agent identity on a human-authored runtime alert", () => {
    const forgedAlert = createAssistantMessage({
      authorId: "user-1",
      messageType: "runtime_alert",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "reviewer", avatarSeed: "reviewer-seed" },
      },
    });

    expect(shouldShowAssistantAvatarForMessage(forgedAlert)).toBe(false);
    expect(shouldShowAssistantIdentityForMessage(forgedAlert, "octo")).toBe(false);
  });
});

describe("resolveTypingAgentLanes", () => {
  const run = (id: string, agent: Record<string, unknown>, options: { status?: "in_progress" | "queued"; groupId?: string } = {}) => ({
    id,
    status: options.status ?? ("in_progress" as const),
    metadata: { agent, ...(options.groupId ? { multiAgentPlan: { groupId: options.groupId, role: "worker" } } : {}) },
  });
  const viewerAgents = new Map([["own-pia", { avatarSeed: "hatchling:7", displayName: "My Pia" }]]);

  it("wears each run's own stamp, and the viewer's profile only for the viewer's own agent by id", () => {
    const { agents } = resolveTypingAgentLanes([
      // Another member's @pia, in a shared chat.
      run("run-peer", { handle: "pia", id: "peer-pia", avatarSeed: "hatchling:2" }),
      // The viewer's own Pia, on a row stamped before its face was picked again.
      run("run-own", { handle: "pia", id: "own-pia", avatarSeed: "hatchling:5" }),
      // A helper, known by its stamp alone.
      run("run-helper", { handle: "reading_list", avatarSeed: "hatchling:1" }),
    ], viewerAgents);
    expect(agents).toEqual([
      { key: "agent:peer-pia", handle: "pia", id: "peer-pia", avatarSeed: "hatchling:2", displayName: "@pia", isThinking: true },
      { key: "agent:own-pia", handle: "pia", id: "own-pia", avatarSeed: "hatchling:7", displayName: "My Pia", isThinking: true },
      { key: "handle:reading_list|hatchling:1", handle: "reading_list", avatarSeed: "hatchling:1", displayName: "@reading_list", isThinking: true },
    ]);
  });

  it("keeps two plans' same-named helpers apart by key, and one lane's reruns as one entry", () => {
    const reviewer = { handle: "reviewer", avatarSeed: "hatchling:3" };
    const runs = [
      run("run-a", reviewer, { groupId: "plan-a", status: "queued" }),
      run("run-b", reviewer, { groupId: "plan-b" }),
      // Plan A's reviewer again: a continuation of the same lane.
      run("run-a2", reviewer, { groupId: "plan-a" }),
    ];
    const { agents, agentByRunId } = resolveTypingAgentLanes(runs, new Map());
    expect(agents.map((agent) => agent.key)).toEqual([
      "handle:reviewer|hatchling:3|plan-a",
      "handle:reviewer|hatchling:3|plan-b",
    ]);
    // Each run names its own lane, and a lane thinks while any of its runs does.
    expect(agentByRunId.get("run-a2")).toBe(agents[0]);
    expect(agentByRunId.get("run-b")).toBe(agents[1]);
    expect(agents[0]?.isThinking).toBe(true);
  });

  it("tells two AIs that share a handle apart by their stamps, and skips runs that name none", () => {
    const { agents, agentByRunId } = resolveTypingAgentLanes([
      run("run-1", { handle: "ben", avatarSeed: "hatchling:2" }, { status: "queued" }),
      run("run-2", { handle: "ben", avatarSeed: "hatchling:6" }, { status: "queued" }),
      { id: "run-3", status: "in_progress" as const, metadata: { runtimeId: "runtime" } },
      { id: "run-4", status: "in_progress" as const, metadata: null },
    ], new Map());
    expect(agents.map((agent) => [agent.avatarSeed, agent.isThinking])).toEqual([["hatchling:2", false], ["hatchling:6", false]]);
    expect(agentByRunId.has("run-3")).toBe(false);
    expect(agentByRunId.has("run-4")).toBe(false);
  });
});

describe("areDistinctAgents", () => {
  it("tells two AIs that share a handle apart only when both stamps say so", () => {
    const pia = (id: string | null, avatarSeed: string) => ({ handle: "pia", avatarSeed, ...(id ? { id } : {}) });
    // Two members' agents, by id; one agent picked another face, by id.
    expect(areDistinctAgents(pia("own-pia", "hatchling:2"), pia("peer-pia", "hatchling:2"))).toBe(true);
    expect(areDistinctAgents(pia("own-pia", "hatchling:2"), pia("own-pia", "hatchling:7"))).toBe(false);
    // Two helpers without ids, by their stamps; legacy rows seed the handle.
    expect(areDistinctAgents(pia(null, "hatchling:2"), pia(null, "hatchling:5"))).toBe(true);
    expect(areDistinctAgents(pia(null, "pia"), pia(null, "pia"))).toBe(false);
    // One id and none, or a row naming no agent: the same speaker.
    expect(areDistinctAgents(pia("own-pia", "hatchling:2"), pia(null, "hatchling:5"))).toBe(false);
    expect(areDistinctAgents(pia("own-pia", "hatchling:2"), null)).toBe(false);
  });
});

describe("resolveViewerAgentProfile", () => {
  const own = { id: "own-pia", handle: "pia", avatarSeed: "hatchling:7" };
  const byId = new Map([[own.id, own]]);
  const byHandle = new Map([[own.handle, own]]);

  it("finds the viewer's saved agent for the single typing face only by the run's exact id", () => {
    expect(resolveViewerAgentProfile({ handle: "pia", id: "own-pia", avatarSeed: "hatchling:2" }, "pia", byId, byHandle)).toBe(own);
    // Another member's @pia, or a helper named pia, is not the viewer's Pia.
    expect(resolveViewerAgentProfile({ handle: "pia", id: "peer-pia", avatarSeed: "hatchling:2" }, "pia", byId, byHandle)).toBeNull();
    expect(resolveViewerAgentProfile({ handle: "pia", avatarSeed: "hatchling:4" }, "pia", byId, byHandle)).toBeNull();
  });

  it("falls back to the conversation's primary agent by handle when nothing is observed", () => {
    expect(resolveViewerAgentProfile(null, "pia", byId, byHandle)).toBe(own);
    expect(resolveViewerAgentProfile(null, "octo", byId, byHandle)).toBeNull();
  });
});
