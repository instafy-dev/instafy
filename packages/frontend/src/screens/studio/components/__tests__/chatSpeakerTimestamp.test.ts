import { describe, expect, it } from "vitest";

import { formatSpeakerTimestamp } from "../chatSpeakerTimestamp";

// Every instant is built from local calendar fields so the day boundaries
// hold in whatever timezone the suite runs in. Mid-July has no daylight
// saving transition anywhere, so local hours and elapsed hours agree.
const localTime = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();

const NOW = localTime(2026, 7, 15, 18, 0);

const timeOnly = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestamp),
  );

const datedLabel = (timestamp: number, options: { withYear?: boolean } = {}) =>
  new Intl.DateTimeFormat(undefined, {
    ...(options.withYear ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));

const labelFor = (timestamp: number, now = NOW) => formatSpeakerTimestamp(timestamp, now)?.label;

describe("formatSpeakerTimestamp", () => {
  it("keeps now and minute labels for recent messages", () => {
    expect(labelFor(NOW - 10 * 1000)).toBe("now");
    expect(labelFor(NOW - 12 * 60 * 1000)).toBe("12m ago");
  });

  it("uses hours for an earlier message on the same local day", () => {
    expect(labelFor(localTime(2026, 7, 15, 12, 0))).toBe("6h ago");
  });

  it("says Yesterday with the time for the previous local day, even under 24h", () => {
    const previousEvening = localTime(2026, 7, 14, 20, 0);
    expect(NOW - previousEvening).toBe(22 * 60 * 60 * 1000);
    expect(labelFor(previousEvening)).toBe(`Yesterday ${timeOnly(previousEvening)}`);

    const justBeforeMidnight = localTime(2026, 7, 14, 23, 0);
    const justAfterMidnight = localTime(2026, 7, 15, 0, 30);
    expect(labelFor(justBeforeMidnight, justAfterMidnight)).toBe(
      `Yesterday ${timeOnly(justBeforeMidnight)}`,
    );
  });

  it("keeps minute labels across midnight", () => {
    expect(labelFor(localTime(2026, 7, 14, 23, 50), localTime(2026, 7, 15, 0, 10))).toBe(
      "20m ago",
    );
  });

  it("includes the date once a message is older than yesterday", () => {
    const earlyMorning = localTime(2026, 7, 15, 2, 0);
    const thirtyHoursEarlier = localTime(2026, 7, 13, 20, 0);
    expect(earlyMorning - thirtyHoursEarlier).toBe(30 * 60 * 60 * 1000);

    const label = labelFor(thirtyHoursEarlier, earlyMorning);
    expect(label).toBe(datedLabel(thirtyHoursEarlier));
    expect(label).not.toBe(timeOnly(thirtyHoursEarlier));
    expect(label).not.toContain("ago");
    expect(label).not.toContain("Yesterday");
  });

  it("adds the year only when it differs from the current year", () => {
    const sameYear = localTime(2026, 3, 2, 9, 30);
    expect(labelFor(sameYear)).toBe(datedLabel(sameYear));

    const lastYear = localTime(2025, 12, 20, 9, 30);
    expect(labelFor(lastYear, localTime(2026, 1, 2, 12, 0))).toBe(
      datedLabel(lastYear, { withYear: true }),
    );
  });

  it("keeps the relative wording for timestamps slightly in the future", () => {
    expect(labelFor(NOW + 5 * 60 * 1000)).toBe("in 5m");
    expect(labelFor(NOW + 3 * 60 * 60 * 1000)).toBe("in 3h");
  });

  it("keeps the full date and time in the hover title", () => {
    const previousEvening = localTime(2026, 7, 14, 20, 0);
    const result = formatSpeakerTimestamp(previousEvening, NOW);
    expect(result?.dateTime).toBe(new Date(previousEvening).toISOString());
    expect(result?.title).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(previousEvening),
      ),
    );
  });

  it("returns null for missing or invalid timestamps", () => {
    expect(formatSpeakerTimestamp(null, NOW)).toBeNull();
    expect(formatSpeakerTimestamp(undefined, NOW)).toBeNull();
    expect(formatSpeakerTimestamp(Number.NaN, NOW)).toBeNull();
    expect(formatSpeakerTimestamp(Number.POSITIVE_INFINITY, NOW)).toBeNull();
    expect(formatSpeakerTimestamp(0, NOW)).toBeNull();
    expect(formatSpeakerTimestamp(-1, NOW)).toBeNull();
    expect(formatSpeakerTimestamp(9e15, NOW)).toBeNull();
  });
});
