import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { resolveChatTranscriptIdentityLayout } from "../chatTranscriptIdentityLayout";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message",
  role: "assistant",
  content: "Here is the comparison.",
  timestamp: 1,
  metadata: { agent: { handle: "octo", avatarSeed: "octo" } },
  ...overrides,
});

function input(overrides: Partial<Parameters<typeof resolveChatTranscriptIdentityLayout>[0]> = {}) {
  return {
    currentUserId: "self",
    chatClientSessionId: "local-session",
    humanPeerContext: { resolved: true, hasHumanPeer: false },
    agentHandles: ["octo"],
    historyComplete: true,
    messages: [message({ id: "prompt", role: "user", authorId: "self", metadata: null }), message()],
    runAgentIdentityByRunId: new Map(),
    runMetadata: [],
    ...overrides,
  } satisfies Parameters<typeof resolveChatTranscriptIdentityLayout>[0];
}

describe("resolveChatTranscriptIdentityLayout", () => {
  it("uses solo layout for a resolved one-human conversation with only built-in Octo", () => {
    expect(resolveChatTranscriptIdentityLayout(input())).toBe("solo");
    expect(resolveChatTranscriptIdentityLayout(input({ agentHandles: [" Octo ", "octo"] }))).toBe("solo");
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [] }))).toBe("solo");
  });

  it.each([
    { currentUserId: null },
    { humanPeerContext: null },
    { humanPeerContext: { resolved: false, hasHumanPeer: false } },
    { humanPeerContext: { resolved: true, hasHumanPeer: true } },
    { historyComplete: false },
    { agentHandles: [] },
    { agentHandles: ["reviewer"] },
    { agentHandles: ["octo", "reviewer"] },
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
    { handle: "octo", id: "saved-agent-one", avatarSeed: "octo" },
    { handle: "octo", id: "saved-agent-two", avatarSeed: "octo" },
    { handle: "octo", avatarSeed: "different-observed-face" },
    { id: "unknown-agent" },
  ])("preserves observed agents rather than treating a matching handle as built-in identity: %j", agent => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [message({ metadata: { agent } })] }))).toBe("participants");
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
  ])("keeps participant identity for nested jobs and plans: %j", metadata => {
    expect(resolveChatTranscriptIdentityLayout(input({ messages: [message({ metadata })] }))).toBe("participants");
  });

  it.each(["multi_agent_plan", "agent_job_thread"])("keeps %s participant identity before nested rows or workers arrive", messageType => {
    // Both raw message kinds and the legacy metadata spelling are rendered
    // as plan/thread entries; neither proves that only Octo authored them.
    for (const entry of [
      message({ messageType }),
      message({ metadata: { message_type: messageType, agent: { handle: "octo" }, details: {} } }),
    ]) {
      expect(resolveChatTranscriptIdentityLayout(input({ messages: [entry] }))).toBe("participants");
    }
  });
});
