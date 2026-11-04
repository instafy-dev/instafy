export type StatusBehavior =
  | { kind: "acknowledgement" }
  | { kind: "informational" }
  | { kind: "action-required" }
  | { kind: "deadline"; expiresAt: number };

/** Opt-in semantics; explicit informational durations remain supported. */
export const statusBehavior = {
  acknowledgement: { kind: "acknowledgement" } as const,
  informational: { kind: "informational" } as const,
  actionRequired: { kind: "action-required" } as const,
  deadline: (expiresAt: number): StatusBehavior => ({ kind: "deadline", expiresAt }),
};

/** Reading allowance for callers that do not supply their own duration. */
export function readableStatusDuration(message: string): number {
  const words = message.trim().split(/\s+/u).filter(Boolean).length;
  return Math.min(30_000, Math.max(5_000, 2_000 + words * 300));
}

export const MAX_PENDING_STATUS_TOASTS = 5;
export const PENDING_INFORMATION_MAX_AGE_MS = 60_000;
