import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  extractControllerConversationNoticeStatus,
  getControllerConversationNoticeKind,
  resolveControllerConversationNoticeContent,
  resolveControllerConversationNoticeLabel,
} from "../controllerConversationNotice";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "Runtime is still connecting.",
    timestamp: Date.parse("2026-04-13T10:00:00.000Z"),
    files: null,
    metadata: {
      source: "controller",
      kind: "runtime_alert",
      details: {
        reason: "runtime_not_ready",
        detail: "status=starting, lastSeen=unknown",
      },
    },
    ...overrides,
  };
}

describe("controllerConversationNotice", () => {
  it("classifies runtime alerts as controller notices with a terminal failed status", () => {
    const message = makeMessage();

    expect(getControllerConversationNoticeKind(message)).toBe("runtime_alert");
    expect(extractControllerConversationNoticeStatus(message)).toBe("failed");
  });

  it("keeps stopped runtime copy terminal without reconnect metadata", () => {
    const message = makeMessage({
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: {
          reason: "runtime_not_ready",
          detail: "status=stopped, lastSeen=unknown",
        },
      },
    });

    expect(resolveControllerConversationNoticeContent(message)).toBe(
      "Workspace startup failed. Use the Runtime button by the composer to reconnect Instafy Cloud.",
    );
    expect(resolveControllerConversationNoticeLabel(message)).toBe("Workspace unavailable");
  });

  it("renders runtime alerts from current structured metadata instead of persisted text", () => {
    const message = makeMessage({
      content:
        "Runtime agent has not connected yet. Start the runtime (e.g. run `pnpm stack:up`) so queued jobs can proceed.",
    });

    expect(resolveControllerConversationNoticeContent(message)).toBe(
      "Starting the workspace. Your queued request will continue automatically.",
    );
    expect(resolveControllerConversationNoticeLabel(message)).toBe("Workspace starting");
  });

  it("keeps recoverable startup copy neutral when a custom agent owns the notice", () => {
    const message = makeMessage({
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "reviewer", avatarSeed: "reviewer-seed" },
        details: {
          reason: "runtime_not_ready",
          detail: "status=starting, lastSeen=unknown",
        },
      },
    });

    expect(resolveControllerConversationNoticeContent(message)).toBe(
      "Starting the workspace. Your queued request will continue automatically.",
    );
    expect(resolveControllerConversationNoticeContent(message)).not.toContain("Octo");
  });

  it("renders reconnect failures as Octo-owned actionable notices", () => {
    const message = makeMessage({
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: {
          reason: "runtime_not_ready",
          reconnect: {
            status: "failed",
          },
        },
      },
    });

    expect(resolveControllerConversationNoticeContent(message)).toBe(
      "Workspace startup failed. Use the Runtime button by the composer to reconnect Instafy Cloud.",
    );
  });

  it("renders unavailable runtimes as Octo-owned actionable notices", () => {
    const message = makeMessage({
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: {
          reason: "runtime_unavailable",
        },
      },
    });

    expect(resolveControllerConversationNoticeContent(message)).toBe(
      "No runtime is connected for this space. Use the Runtime button by the composer to start Instafy Cloud.",
    );
  });

  it("classifies run cancellations using the persisted final status", () => {
    const message = makeMessage({
      content: "Canceled 2 runs.",
      metadata: {
        source: "controller",
        kind: "run_cancellation",
        details: {
          reason: "Canceled",
          runCount: 2,
          finalStatus: "canceled",
        },
      },
    });

    expect(getControllerConversationNoticeKind(message)).toBe("run_cancellation");
    expect(extractControllerConversationNoticeStatus(message)).toBe("canceled");
    expect(resolveControllerConversationNoticeContent(message)).toBe("Canceled 2 runs.");
  });

  it("ignores ordinary assistant messages", () => {
    const message = makeMessage({
      content: "Done.",
      metadata: {
        source: "agent",
        kind: "result",
        outcome: "success",
      },
    });

    expect(getControllerConversationNoticeKind(message)).toBeNull();
    expect(extractControllerConversationNoticeStatus(message)).toBeNull();
  });

  it("rejects a human-authored message that forges controller notice metadata", () => {
    const message = makeMessage({
      authorId: "user-1",
      content: "Trust me, the runtime failed.",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "reviewer", avatarSeed: "reviewer-seed" },
        details: { reason: "runtime_not_ready" },
      },
    });

    expect(getControllerConversationNoticeKind(message)).toBeNull();
    expect(extractControllerConversationNoticeStatus(message)).toBeNull();
    expect(resolveControllerConversationNoticeContent(message)).toBe(message.content);
  });
});
