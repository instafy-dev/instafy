const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Labels are grouped by the viewer's local calendar day rather than a rolling
 * 24h window. A rolling window let a morning message from yesterday show a
 * bare clock time that read like today while a later message still said
 * "22h ago", so an older message looked newer than the one below it.
 */
export function formatSpeakerTimestamp(
  timestamp: number | null | undefined,
  now: number = Date.now(),
): {
  label: string;
  dateTime: string;
  title: string;
} | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const nowDate = new Date(now);
  const deltaMs = timestamp - now;
  const absoluteDeltaMs = Math.abs(deltaMs);
  // Built from calendar fields so a day with a daylight saving change still
  // resolves to the previous calendar date.
  const yesterday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1);
  let label: string;
  if (absoluteDeltaMs < 45 * 1000) {
    label = "now";
  } else if (absoluteDeltaMs < HOUR_MS) {
    const amount = Math.max(1, Math.round(absoluteDeltaMs / MINUTE_MS));
    label = deltaMs < 0 ? `${amount}m ago` : `in ${amount}m`;
  } else if (deltaMs > 0 && absoluteDeltaMs < DAY_MS) {
    // Future stamps only come from clock skew, so they keep the short
    // relative wording instead of a calendar label.
    const amount = Math.max(1, Math.round(absoluteDeltaMs / HOUR_MS));
    label = `in ${amount}h`;
  } else if (deltaMs < 0 && isSameLocalDay(date, nowDate)) {
    const amount = Math.max(1, Math.round(absoluteDeltaMs / HOUR_MS));
    label = `${amount}h ago`;
  } else if (deltaMs < 0 && isSameLocalDay(date, yesterday)) {
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    label = `Yesterday ${time}`;
  } else {
    // Anything older carries its date so it cannot be mistaken for today.
    label = new Intl.DateTimeFormat(undefined, {
      ...(date.getFullYear() !== nowDate.getFullYear() ? { year: "numeric" as const } : {}),
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return {
    label,
    dateTime: date.toISOString(),
    title: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}
