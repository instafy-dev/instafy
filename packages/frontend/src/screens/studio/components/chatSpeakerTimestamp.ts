export function formatSpeakerTimestamp(timestamp: number | null | undefined): {
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
  const now = Date.now();
  const deltaMs = timestamp - now;
  const absoluteDeltaMs = Math.abs(deltaMs);
  const relativeThresholdMs = 24 * 60 * 60 * 1000;
  let label: string;
  if (absoluteDeltaMs < 45 * 1000) {
    label = "now";
  } else if (absoluteDeltaMs < relativeThresholdMs) {
    const unit =
      absoluteDeltaMs < 60 * 60 * 1000
        ? "minute"
        : "hour";
    const unitMs = unit === "minute" ? 60 * 1000 : 60 * 60 * 1000;
    const amount = Math.max(1, Math.round(absoluteDeltaMs / unitMs));
    const suffix = unit === "minute" ? "m" : "h";
    label = deltaMs < 0 ? `${amount}${suffix} ago` : `in ${amount}${suffix}`;
  } else {
    label = new Intl.DateTimeFormat(undefined, {
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
