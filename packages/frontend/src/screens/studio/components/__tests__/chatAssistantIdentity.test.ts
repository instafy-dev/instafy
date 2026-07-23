import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  shouldShowAssistantAvatarForMessage,
  shouldShowAssistantIdentityForMessage,
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
