import { describe, expect, it } from "vitest";
import {
  describeManagedAiNextAvailable,
  isManagedAiAllowanceUsedUp,
} from "../managedAiAllowance";

const usedUp = {
  enabled: true,
  available: false,
  dailyPromptLimit: 20,
  remainingPrompts: 0,
};

const clock = (at: Date) => at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

describe("isManagedAiAllowanceUsedUp", () => {
  it("is true only when hosted AI is on and no prompts are left", () => {
    expect(isManagedAiAllowanceUsedUp(usedUp)).toBe(true);
    // Hosted AI off (a self-hosted controller without it): not a quota.
    expect(isManagedAiAllowanceUsedUp({ ...usedUp, enabled: false })).toBe(false);
    // Paused or unreachable with prompts left: a different problem.
    expect(isManagedAiAllowanceUsedUp({ ...usedUp, remainingPrompts: 7 })).toBe(false);
    // No daily limit configured.
    expect(
      isManagedAiAllowanceUsedUp({ ...usedUp, dailyPromptLimit: 0, remainingPrompts: null }),
    ).toBe(false);
    expect(isManagedAiAllowanceUsedUp({ ...usedUp, available: true })).toBe(false);
    expect(isManagedAiAllowanceUsedUp(null)).toBe(false);
  });
});

describe("describeManagedAiNextAvailable", () => {
  const now = new Date(2026, 9, 26, 9, 0);

  it("names the time when more are available later today", () => {
    const at = new Date(2026, 9, 26, 15, 40);
    expect(describeManagedAiNextAvailable(at.toISOString(), now)).toBe(
      `More are available at ${clock(at)}.`,
    );
  });

  it("says tomorrow when the rolling window reopens after midnight", () => {
    const at = new Date(2026, 9, 27, 8, 5);
    expect(describeManagedAiNextAvailable(at.toISOString(), now)).toBe(
      `More are available tomorrow at ${clock(at)}.`,
    );
  });

  it("says later without a usable time", () => {
    expect(describeManagedAiNextAvailable(null, now)).toBe("More are available later.");
    expect(describeManagedAiNextAvailable(undefined, now)).toBe("More are available later.");
    expect(describeManagedAiNextAvailable("not a time", now)).toBe("More are available later.");
  });

  it("does not say later once the stated time has passed", () => {
    // The gate re-checks at that time, so the wait is about to end.
    for (const at of [new Date(2026, 9, 26, 8, 0), now]) {
      const sentence = describeManagedAiNextAvailable(at.toISOString(), now);
      expect(sentence).toBe("More should be available in a moment.");
      expect(sentence).not.toContain("later");
    }
  });
});
