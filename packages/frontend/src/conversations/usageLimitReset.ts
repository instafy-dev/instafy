/**
 * When an AI's spent usage limit opens again, as a failure names it in UTC.
 *
 * The AI service words that time in the clock of the machine the turn ran on
 * ("Try again at Nov 14th, 2026 11:03 PM."), which nobody reading the chat
 * elsewhere can place. The runtime turns it into the same moment in UTC
 * ("Try again at 2026-11-14 23:03 UTC.", runtime-agent
 * `usage_limit_reset_in_utc`), as it already names a Claude Code plan's reset
 * ("The limit resets at 2026-11-14 23:03 UTC."). Studio says that moment in
 * the clock of whoever reads the chat.
 */
import { isSameLocalDay } from "../utils/time";

const RESET_IN_UTC_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\s*UTC\b/u;

/** The moment the text names in UTC, as epoch ms; null when it names none. */
export function readUsageLimitResetAt(rawText: string): number | null {
  const match = RESET_IN_UTC_PATTERN.exec(rawText);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }
  const at = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(at);
  // A day the month doesn't have (Feb 30) is no moment.
  return date.getUTCDate() === day ? at : null;
}

/**
 * That moment in the reader's own clock: the time alone on the same day
 * ("11:03 PM"), else with its day ("Sun, Nov 15, 12:03 AM"), and its year
 * when that is another.
 */
export function formatUsageLimitResetTime(resetsAt: number, now: number = Date.now()): string {
  const date = new Date(resetsAt);
  const today = new Date(now);
  if (isSameLocalDay(date, today)) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** {@link formatUsageLimitResetTime} of the moment the text names in UTC; null when it names none. */
export function usageLimitResetTimeForReader(rawText: string, now: number = Date.now()): string | null {
  const resetsAt = readUsageLimitResetAt(rawText);
  return resetsAt === null ? null : formatUsageLimitResetTime(resetsAt, now);
}
