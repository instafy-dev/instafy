import { describe, expect, it } from "vitest";
import {
  resolveStaleStartingRecoveryKey,
  STALE_STARTING_RECOVERY_DELAY_MS,
} from "../staleStartingRecovery";

describe("staleStartingRecovery", () => {
  it("returns a recovery key when chat is stuck waiting despite a ready runtime", () => {
    expect(
      resolveStaleStartingRecoveryKey({
        isAssistantTyping: true,
        typingPhase: "waiting",
        runtimeControllerEnabled: true,
        runtimeReady: true,
        waitingForPreferredRuntime: false,
        hostedRuntimeEnsuring: false,
        runtimeEnsureError: null,
        activeConversationId: "local-conv",
        activeConversationControllerId: "controller-conv",
        pendingRunIds: ["run-b", "run-a"],
      }),
    ).toBe("controller-conv:run-a,run-b");
    expect(STALE_STARTING_RECOVERY_DELAY_MS).toBe(12_000);
  });

  it("returns null when the runtime is still genuinely booting or errored", () => {
    expect(
      resolveStaleStartingRecoveryKey({
        isAssistantTyping: true,
        typingPhase: "waiting",
        runtimeControllerEnabled: true,
        runtimeReady: false,
        waitingForPreferredRuntime: false,
        hostedRuntimeEnsuring: false,
        runtimeEnsureError: null,
        activeConversationId: "local-conv",
        activeConversationControllerId: "controller-conv",
        pendingRunIds: ["run-a"],
      }),
    ).toBeNull();

    expect(
      resolveStaleStartingRecoveryKey({
        isAssistantTyping: true,
        typingPhase: "waiting",
        runtimeControllerEnabled: true,
        runtimeReady: true,
        waitingForPreferredRuntime: false,
        hostedRuntimeEnsuring: false,
        runtimeEnsureError: "controller unavailable",
        activeConversationId: "local-conv",
        activeConversationControllerId: "controller-conv",
        pendingRunIds: ["run-a"],
      }),
    ).toBeNull();
  });

  it("returns null once the conversation has moved past the waiting phase", () => {
    expect(
      resolveStaleStartingRecoveryKey({
        isAssistantTyping: true,
        typingPhase: "thinking",
        runtimeControllerEnabled: true,
        runtimeReady: true,
        waitingForPreferredRuntime: false,
        hostedRuntimeEnsuring: false,
        runtimeEnsureError: null,
        activeConversationId: "local-conv",
        activeConversationControllerId: "controller-conv",
        pendingRunIds: [],
      }),
    ).toBeNull();
  });
});
