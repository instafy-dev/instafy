import type {
  ParticipantSubscriptionUsage,
  ParticipantUsageWindow,
} from "./chatParticipantsStore";

/**
 * Parsing and display helpers for BYOC subscription usage (the ChatGPT/Codex
 * rate-limit windows the proxy captures and the controller returns on
 * `/me/credentials`). Kept out of the store so the store stays free of view
 * logic, and out of ChatPanel so the drawer can reuse the formatters.
 */

function coercePercent(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function coerceWindow(raw: unknown): ParticipantUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const usedPercent = coercePercent(record.usedPercent);
  const windowMinutes =
    typeof record.windowMinutes === "number" ? record.windowMinutes : Number(record.windowMinutes);
  if (usedPercent === null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }
  const resetAt =
    typeof record.resetAt === "number" ? record.resetAt : Number(record.resetAt);
  const kind = record.kind === "secondary" ? "secondary" : "primary";
  return {
    kind,
    usedPercent,
    windowMinutes,
    resetAt: Number.isFinite(resetAt) ? resetAt : 0,
  };
}

/**
 * Defensively parses whatever `/me/credentials` returned for `subscriptionUsage`
 * into the store shape. Returns null when nothing usable is present — a
 * non-subscription credential, an unseeded one, or malformed data.
 */
export function parseSubscriptionUsage(raw: unknown): ParticipantSubscriptionUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const windows = Array.isArray(record.windows)
    ? record.windows.map(coerceWindow).filter((w): w is ParticipantUsageWindow => w !== null)
    : [];
  if (windows.length === 0) return null;
  const capturedAt =
    typeof record.capturedAt === "number" ? record.capturedAt : Number(record.capturedAt);
  return {
    windows,
    planName: typeof record.planName === "string" && record.planName.trim() ? record.planName : null,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
  };
}

/**
 * Short label for a window keyed off its length: "5h" for the rolling window,
 * "Weekly" for the ~7-day one. Falls back to a sensible hours/days/minutes
 * rendering for anything else the upstream sends.
 */
export function windowLabel(windowMinutes: number): string {
  if (windowMinutes >= 6 * 24 * 60) return "Weekly";
  if (windowMinutes >= 24 * 60 && windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 1 ? "Daily" : `${days}d`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/**
 * Human reset time. Relative ("resets in 2h 10m") when it lands today or within
 * ~12h — the "close" case the drawer wants front-and-center — and absolute
 * ("resets Tue", "resets Aug 30") when it's further out. `nowMs` is passed in so
 * the caller controls the clock (and tests stay deterministic).
 */
export function formatReset(resetAtSeconds: number, nowMs: number): string | null {
  if (!Number.isFinite(resetAtSeconds) || resetAtSeconds <= 0) return null;
  const resetMs = resetAtSeconds * 1000;
  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return "resets now";

  const reset = new Date(resetMs);
  const now = new Date(nowMs);
  const sameDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  const within12h = diffMs <= 12 * 60 * 60 * 1000;

  if (sameDay || within12h) {
    const totalMinutes = Math.round(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
    if (totalMinutes >= 1) return `resets in ${totalMinutes}m`;
    return "resets in <1m";
  }

  const withinWeek = diffMs < 6 * 24 * 60 * 60 * 1000;
  const formatted = withinWeek
    ? reset.toLocaleDateString(undefined, { weekday: "short" })
    : reset.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `resets ${formatted}`;
}
