export const STALE_STARTING_RECOVERY_DELAY_MS = 12_000;

type TypingPhase = "waiting" | "thinking" | "typing" | "finalizing" | "compacting" | null;

export interface ResolveStaleStartingRecoveryKeyInput {
  isAssistantTyping: boolean;
  typingPhase: TypingPhase;
  runtimeControllerEnabled: boolean;
  runtimeReady: boolean;
  waitingForPreferredRuntime: boolean;
  hostedRuntimeEnsuring: boolean;
  runtimeEnsureError?: string | null;
  activeConversationId: string | null;
  activeConversationControllerId: string | null;
  pendingRunIds: string[];
}

export function resolveStaleStartingRecoveryKey(
  input: ResolveStaleStartingRecoveryKeyInput,
): string | null {
  if (!input.isAssistantTyping || input.typingPhase !== "waiting") {
    return null;
  }
  if (!input.runtimeControllerEnabled || !input.runtimeReady) {
    return null;
  }
  if (input.waitingForPreferredRuntime || input.hostedRuntimeEnsuring) {
    return null;
  }
  if (typeof input.runtimeEnsureError === "string" && input.runtimeEnsureError.trim().length > 0) {
    return null;
  }

  const conversationKey =
    input.activeConversationControllerId?.trim() || input.activeConversationId?.trim() || "";
  if (!conversationKey) {
    return null;
  }

  const pendingRunKey = input.pendingRunIds
    .map((runId) => runId.trim())
    .filter((runId) => runId.length > 0)
    .sort()
    .join(",");

  return `${conversationKey}:${pendingRunKey || "pending"}`;
}
