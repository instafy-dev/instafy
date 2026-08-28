import { describe, expect, it } from "vitest";
import { parseSubscriptionUsage } from "../credentials";

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
