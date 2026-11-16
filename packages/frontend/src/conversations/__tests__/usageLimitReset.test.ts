import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatUsageLimitResetTime, readUsageLimitResetAt, usageLimitResetTimeForReader } from "../usageLimitReset";

describe("when an AI's usage limit opens again", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Europe/Warsaw";
  });
  afterEach(() => {
    process.env.TZ = zone;
  });

  it("reads the moment a failure names in UTC, and nothing else", () => {
    const at = Date.UTC(2026, 10, 14, 23, 3);
    expect(readUsageLimitResetAt("You’ve hit your usage limit. Try again at 2026-11-14 23:03 UTC.")).toBe(at);
    expect(readUsageLimitResetAt("Claude AI usage limit reached\nThe limit resets at 2026-11-14 23:03 UTC.")).toBe(at);
    expect(readUsageLimitResetAt("…or try again at 2026-11-14T23:03:00 UTC.")).toBe(at);
    // A time in the service machine's own clock is no moment.
    expect(readUsageLimitResetAt("You’ve hit your usage limit. Try again at Nov 14th, 2026 11:03 PM.")).toBeNull();
    expect(readUsageLimitResetAt("You’ve hit your usage limit. Try again at 11:03 PM.")).toBeNull();
    expect(readUsageLimitResetAt("Try again later.")).toBeNull();
    // A day or a time that does not exist.
    expect(readUsageLimitResetAt("Try again at 2026-02-30 10:00 UTC.")).toBeNull();
    expect(readUsageLimitResetAt("Try again at 2026-11-14 24:10 UTC.")).toBeNull();
  });

  it("says it in the reader's own clock: the time alone on their day, else with its day, and its year when another", () => {
    const at = Date.UTC(2026, 10, 14, 23, 3);
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, { ...options, timeZone: "Europe/Warsaw" }).format(new Date(at));
    // Sunday 00:03 an hour east of UTC, read on Sunday night there: the time alone.
    expect(formatUsageLimitResetTime(at, Date.UTC(2026, 10, 14, 23, 30))).toBe(format({ hour: "numeric", minute: "2-digit" }));
    // Read on Saturday evening there: with its day.
    expect(formatUsageLimitResetTime(at, Date.UTC(2026, 10, 14, 20, 0))).toBe(
      format({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    );
    // Read the year before: with its year.
    expect(formatUsageLimitResetTime(at, Date.UTC(2025, 11, 31, 12, 0))).toBe(
      format({ year: "numeric", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    );
    expect(usageLimitResetTimeForReader("Try again at 2026-11-14 23:03 UTC.", Date.UTC(2026, 10, 14, 20, 0))).toBe(
      format({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    );
    expect(usageLimitResetTimeForReader("Try again later.")).toBeNull();
  });
});
