import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  extractControllerConversationNoticeStatus,
  getControllerConversationNoticeKind,
  resolveControllerConversationNoticeContent,
  resolveControllerConversationNoticeAction,
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
      "Workspace startup failed. Open Machines to reconnect Instafy Cloud.",
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
      "Workspace startup failed. Open Machines to reconnect Instafy Cloud.",
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
      "No runtime is connected for this space. Open Machines to start Instafy Cloud.",
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

  describe("notice actions", () => {
    it("offers the self-host dialog when a schedule's own machine was offline", () => {
      // The controller's sentence names the pinned machine; only that machine
      // satisfies the run, so the honest action is instructions, not a start.
      const message = makeMessage({
        content:
          "This scheduled run couldn't start: no self-hosted runtime was online for this space; " +
          "this schedule is pinned to a self-hosted machine, so start Instafy on that machine and " +
          "the next scheduled run will pick it up",
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          details: { reason: "automation_launch_failed", automationId: "a-1" },
        },
      });

      expect(resolveControllerConversationNoticeAction(message)).toEqual({
        label: "How to start it",
        kind: "desktop_runtime_help",
      });
    });

    it("sends other scheduled-run failures to Machines", () => {
      const message = makeMessage({
        content: "This scheduled run couldn't start: workspace runtime limit reached",
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          details: { reason: "automation_launch_failed", automationId: "a-1" },
        },
      });

      expect(resolveControllerConversationNoticeAction(message)?.kind).toBe("open_machines");
    });

    it("offers nothing while a workspace start is still in flight", () => {
      expect(resolveControllerConversationNoticeAction(makeMessage())).toBeNull();
    });

    it("offers Machines for a terminal runtime alert", () => {
      const message = makeMessage({
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          details: { reason: "runtime_unavailable" },
        },
      });

      expect(resolveControllerConversationNoticeAction(message)).toEqual({
        label: "Open Machines",
        kind: "open_machines",
      });
    });

    it("never actions a cancellation notice", () => {
      const message = makeMessage({
        content: "Canceled 1 run.",
        metadata: { source: "controller", kind: "run_cancellation", details: {} },
      });

      expect(resolveControllerConversationNoticeAction(message)).toBeNull();
    });

    it("keeps the self-host marker in step with the controller", () => {
      // The Rust side pins the same substring (SELF_HOSTED_LAUNCH_MARKER in
      // packages/runtime-controller/src/automations.rs). Editing one sentence
      // without the other silently drops the button, so both sides assert it.
      const marker = "no self-hosted runtime was online for this space";
      const message = makeMessage({
        content: `This scheduled run couldn't start: ${marker}; and some tail`,
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          details: { reason: "automation_launch_failed" },
        },
      });

      expect(resolveControllerConversationNoticeAction(message)?.kind).toBe(
        "desktop_runtime_help",
      );
    });
  });

  it("no longer points at the composer runtime button, which has no renderer", () => {
    for (const reason of [
      "runtime_not_ready",
      "runtime_unavailable",
      "runtime_inspection_failed",
      "something_unmapped",
    ]) {
      const content = resolveControllerConversationNoticeContent(
        makeMessage({
          content: "Runtime is unavailable.",
          metadata: {
            source: "controller",
            kind: "runtime_alert",
            details: { reason, detail: "status=stopped" },
          },
        }),
      );
      expect(content).not.toContain("Runtime button by the composer");
    }
  });
});