export type ManagedAiAllowance = {
  enabled: boolean;
  available: boolean;
  dailyPromptLimit: number;
  remainingPrompts: number | null;
  /** When the next prompt frees up (ISO time), once the allowance is used up. */
  nextAvailableAt?: string | null;
};

/**
 * Hosted AI is on, but this person has sent every prompt the daily allowance
 * gives. It is off for other reasons too (paused, a proxy problem), and those
 * keep the plain connect prompt.
 */
export function isManagedAiAllowanceUsedUp(
  managedAi: ManagedAiAllowance | null | undefined,
): boolean {
  return Boolean(
    managedAi &&
      managedAi.enabled &&
      !managedAi.available &&
      managedAi.dailyPromptLimit > 0 &&
      managedAi.remainingPrompts === 0,
  );
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * The sentence that says when hosted AI messages are available again. The
 * controller counts a rolling 24 hours, so the time can fall on the next day.
 * Without a usable time (an older controller) it says "later" rather than
 * guessing. Once the stated time has passed the gate is about to re-check (see
 * useChatCredentialGate), so it does not push the reader to "later" then.
 */
export function describeManagedAiNextAvailable(
  nextAvailableAt: string | null | undefined,
  now: Date = new Date(),
): string {
  const at = typeof nextAvailableAt === "string" ? new Date(nextAvailableAt) : null;
  if (!at || !Number.isFinite(at.getTime())) {
    return "More are available later.";
  }
  if (at.getTime() <= now.getTime()) {
    return "More should be available in a moment.";
  }
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isSameLocalDay(at, now)) {
    return `More are available at ${time}.`;
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (isSameLocalDay(at, tomorrow)) {
    return `More are available tomorrow at ${time}.`;
  }
  const day = at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `More are available on ${day} at ${time}.`;
}
