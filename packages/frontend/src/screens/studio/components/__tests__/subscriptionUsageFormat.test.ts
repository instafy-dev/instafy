import { describe, expect, it } from "vitest";
import {
  formatReset,
  parseSubscriptionUsage,
  windowLabel,
} from "../subscriptionUsageFormat";

const NOW = Date.parse("2026-08-28T10:00:00Z");
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("parseSubscriptionUsage", () => {
  it("keeps well-formed windows and clamps the percent", () => {
    const usage = parseSubscriptionUsage({
      windows: [
        { kind: "primary", usedPercent: 12.6, windowMinutes: 300, resetAt: at("2026-08-28T12:00:00Z") },
        { kind: "secondary", usedPercent: 140, windowMinutes: 10080, resetAt: at("2026-09-02T00:00:00Z") },
      ],
      planName: "GPT-5.5-Codex",
      capturedAt: at("2026-08-28T09:55:00Z"),
    });
    expect(usage).not.toBeNull();
    expect(usage?.windows).toHaveLength(2);
    expect(usage?.windows[0]?.usedPercent).toBe(13); // rounded
    expect(usage?.windows[1]?.usedPercent).toBe(100); // clamped
    expect(usage?.planName).toBe("GPT-5.5-Codex");
  });

  it("drops windows without a length or a usable percent", () => {
    const usage = parseSubscriptionUsage({
      windows: [
        { kind: "primary", usedPercent: 5, windowMinutes: 0, resetAt: 0 },
        { kind: "secondary", windowMinutes: 10080, resetAt: 0 },
        { kind: "primary", usedPercent: 30, windowMinutes: 300, resetAt: at("2026-08-28T12:00:00Z") },
      ],
      capturedAt: at("2026-08-28T09:55:00Z"),
    });
    expect(usage?.windows).toHaveLength(1);
    expect(usage?.windows[0]?.usedPercent).toBe(30);
  });

  it("returns null for missing, malformed, or empty payloads", () => {
    expect(parseSubscriptionUsage(null)).toBeNull();
    expect(parseSubscriptionUsage(undefined)).toBeNull();
    expect(parseSubscriptionUsage({})).toBeNull();
    expect(parseSubscriptionUsage({ windows: [] })).toBeNull();
    expect(parseSubscriptionUsage("nope")).toBeNull();
  });
});

describe("windowLabel", () => {
  it("names the common windows and falls back sensibly", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(60)).toBe("1h");
    expect(windowLabel(10080)).toBe("Weekly");
    expect(windowLabel(1440)).toBe("Daily");
    expect(windowLabel(2880)).toBe("2d");
    expect(windowLabel(45)).toBe("45m");
  });
});

describe("formatReset", () => {
  it("is relative when the reset is today or within ~12h", () => {
    expect(formatReset(at("2026-08-28T12:10:00Z"), NOW)).toBe("resets in 2h 10m");
    expect(formatReset(at("2026-08-28T10:40:00Z"), NOW)).toBe("resets in 40m");
    expect(formatReset(at("2026-08-28T10:00:15Z"), NOW)).toBe("resets in <1m");
  });

  it("shows 'resets now' once the window has lapsed", () => {
    expect(formatReset(at("2026-08-28T09:00:00Z"), NOW)).toBe("resets now");
  });

  it("goes absolute when the reset is days out", () => {
    // Several days ahead → not relative (no "resets in").
    const label = formatReset(at("2026-09-02T09:00:00Z"), NOW);
    expect(label).not.toBeNull();
    expect(label).not.toContain("resets in");
    expect(label?.startsWith("resets ")).toBe(true);
  });

  it("returns null when there is no reset timestamp", () => {
    expect(formatReset(0, NOW)).toBeNull();
    expect(formatReset(Number.NaN, NOW)).toBeNull();
  });
});
