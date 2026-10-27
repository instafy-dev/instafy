import { describe, expect, it } from "vitest";
import {
  canChooseManagedAi,
  describeManagedAiNextAvailable,
  describeManagedAiUnavailable,
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

describe("describeManagedAiUnavailable", () => {
  const full = { enabled: true, available: true, dailyPromptLimit: 20, remainingPrompts: 20 };

  it("says nothing while Instafy AI can run turns, whoever is the default", () => {
    expect(describeManagedAiUnavailable(full, { hasOwnDefault: true })).toBeNull();
    expect(describeManagedAiUnavailable(full, { hasOwnDefault: false })).toBeNull();
    expect(describeManagedAiUnavailable(null, { hasOwnDefault: false })).toBeNull();
  });

  it("does not guess when an older controller gives no reason and the default is the person's own AI", () => {
    // Older controllers reported available: false for exactly that reason.
    expect(describeManagedAiUnavailable({ ...full, available: false }, { hasOwnDefault: true })).toBeNull();
    expect(describeManagedAiUnavailable({ ...full, available: false }, { hasOwnDefault: false })).toBe(
      "Currently unavailable.",
    );
  });

  it("names the reason in plain words", () => {
    const off = (unavailableReason: string) => ({ ...full, available: false, unavailableReason });
    expect(describeManagedAiUnavailable(off("no_proxy"), { hasOwnDefault: true })).toBe(
      "This server isn't set up to run it yet.",
    );
    expect(describeManagedAiUnavailable(off("proxy_needs_credential"), { hasOwnDefault: false })).toBe(
      "This server isn't set up to run it yet.",
    );
    expect(describeManagedAiUnavailable(off("proxy_unreachable"), { hasOwnDefault: true })).toBe(
      "Can't be reached right now. Try again in a minute.",
    );
    expect(
      describeManagedAiUnavailable(
        { ...off("daily_limit_reached"), remainingPrompts: 0 },
        { hasOwnDefault: true },
      ),
    ).toBe("Today's 20 prompts are used. More are available later.");
    // An older controller's used-up allowance reads the same.
    expect(describeManagedAiUnavailable(usedUp, { hasOwnDefault: false })).toBe(
      "Today's 20 prompts are used. More are available later.",
    );
  });
});

describe("canChooseManagedAi", () => {
  it("offers Instafy AI when it can run turns or only today's prompts are used", () => {
    const base = { enabled: true, available: true, dailyPromptLimit: 20, remainingPrompts: 20 };
    expect(canChooseManagedAi(base)).toBe(true);
    expect(canChooseManagedAi({ ...base, available: false, unavailableReason: "daily_limit_reached" })).toBe(true);
    // An older controller says nothing about why: keep offering it.
    expect(canChooseManagedAi({ ...base, available: false })).toBe(true);
    expect(canChooseManagedAi({ ...base, available: false, unavailableReason: "no_proxy" })).toBe(false);
    expect(canChooseManagedAi({ ...base, available: false, unavailableReason: "proxy_unreachable" })).toBe(false);
    expect(canChooseManagedAi({ ...base, enabled: false })).toBe(false);
    expect(canChooseManagedAi(null)).toBe(false);
  });
});
