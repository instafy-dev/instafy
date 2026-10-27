import { describe, expect, it } from "vitest";
import { parseManagedAiAccess, parseSubscriptionUsage } from "../credentials";

describe("parseSubscriptionUsage (controller contract boundary)", () => {
  it("keeps a window that has no reset time (proxy omits resetAt)", () => {
    // The proxy emits windows without a resetAt when the upstream sends no
    // reset header. Such a window is still usable and must not be dropped.
    const usage = parseSubscriptionUsage({
      windows: [{ kind: "primary", usedPercent: 42, windowMinutes: 300 }],
      planName: "GPT-5.5-Codex",
      capturedAt: 1756377600,
    });
    expect(usage).not.toBeNull();
    expect(usage?.windows).toHaveLength(1);
    expect(usage?.windows[0]?.resetAt).toBe(0); // defaulted, not dropped
    expect(usage?.planName).toBe("GPT-5.5-Codex");
  });

  it("drops windows missing a numeric percent or length", () => {
    const usage = parseSubscriptionUsage({
      windows: [
        { kind: "primary", windowMinutes: 300 }, // no usedPercent
        { kind: "bogus", usedPercent: 5, windowMinutes: 300 }, // bad kind
        { kind: "secondary", usedPercent: 40, windowMinutes: 10080, resetAt: 123 },
      ],
      capturedAt: 1756377600,
    });
    expect(usage?.windows).toHaveLength(1);
    expect(usage?.windows[0]?.kind).toBe("secondary");
  });

  it("returns null for missing, malformed, or empty payloads", () => {
    expect(parseSubscriptionUsage(null)).toBeNull();
    expect(parseSubscriptionUsage(undefined)).toBeNull();
    expect(parseSubscriptionUsage({})).toBeNull();
    expect(parseSubscriptionUsage({ windows: [] })).toBeNull();
  });
});

describe("parseManagedAiAccess (controller contract boundary)", () => {
  const usedUp = {
    enabled: true,
    available: false,
    label: "Instafy AI",
    creditBurnAmount: 1,
    dailyPromptLimit: 20,
    dailyPromptsUsed: 20,
    remainingPrompts: 0,
  };

  it("keeps when the next hosted AI prompt frees up", () => {
    expect(
      parseManagedAiAccess({ ...usedUp, nextAvailableAt: "2026-10-27T08:00:00Z" })?.nextAvailableAt,
    ).toBe("2026-10-27T08:00:00Z");
  });

  it("reads an older controller without the time, or a malformed one, as unknown", () => {
    expect(parseManagedAiAccess(usedUp)).toMatchObject({ remainingPrompts: 0, nextAvailableAt: null });
    expect(parseManagedAiAccess({ ...usedUp, nextAvailableAt: "soon" })?.nextAvailableAt).toBeNull();
    expect(parseManagedAiAccess({ ...usedUp, nextAvailableAt: 1761552000 })?.nextAvailableAt).toBeNull();
  });

  it("keeps why hosted AI is unavailable, and drops reasons it does not know", () => {
    expect(
      parseManagedAiAccess({ ...usedUp, unavailableReason: "daily_limit_reached" })?.unavailableReason,
    ).toBe("daily_limit_reached");
    expect(parseManagedAiAccess({ ...usedUp, unavailableReason: "no_proxy" })?.unavailableReason).toBe(
      "no_proxy",
    );
    expect(parseManagedAiAccess({ ...usedUp, unavailableReason: "solar_flare" })?.unavailableReason).toBeNull();
    expect(parseManagedAiAccess(usedUp)?.unavailableReason).toBeNull();
  });

  it("returns null without a managedAi block", () => {
    expect(parseManagedAiAccess(undefined)).toBeNull();
    expect(parseManagedAiAccess(null)).toBeNull();
    expect(parseManagedAiAccess("managed")).toBeNull();
  });
});
