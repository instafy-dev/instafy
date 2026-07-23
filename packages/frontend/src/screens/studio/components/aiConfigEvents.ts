export const AI_CONFIG_CHANGED_EVENT = "instafy:ai-config-changed";

export function emitAiConfigChanged(reason: string = "updated"): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(AI_CONFIG_CHANGED_EVENT, {
      detail: {
        reason,
        at: Date.now(),
      },
    }),
  );
}

