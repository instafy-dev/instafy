export interface RelativeTimeDescription {
  text: string;
  isPast: boolean;
  milliseconds: number;
}

export function describeTimeUntil(
  targetIso: string | null | undefined,
  nowMs: number = Date.now(),
): RelativeTimeDescription | null {
  if (!targetIso) {
    return null;
  }
  const timestamp = Date.parse(targetIso);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMs = timestamp - nowMs;
  const text = formatDurationShort(Math.abs(diffMs));
  const isPast = diffMs <= 0;
  return {
    text,
    isPast,
    milliseconds: diffMs,
  };
}

export function formatDurationShort(milliseconds: number): string {
  const absMs = Math.abs(milliseconds);
  if (!Number.isFinite(absMs)) {
    return "";
  }
  const totalMinutes = Math.round(absMs / 60000);
  if (totalMinutes <= 0) {
    return "<1m";
  }
  if (totalMinutes >= 1440) {
    const days = Math.floor(totalMinutes / 1440);
    const remainingMinutes = totalMinutes % 1440;
    const hours = Math.floor(remainingMinutes / 60);
    if (hours === 0) {
      return `${days}d`;
    }
    return `${days}d ${hours}h`;
  }
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (minutes === 0) {
      return `${hours}h`;
    }
    return `${hours}h ${minutes}m`;
  }
  return `${totalMinutes}m`;
}
