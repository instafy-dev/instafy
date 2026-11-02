import type { ChatMessage } from "../types";
import { isBrowserNoticePrompt, isUnsentBrowserNoticePrompt } from "./browserHandBack";

const IDLE_GAP_MS = 60 * 60 * 1000;

function sentDate(timestamp: unknown): Date | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function hiddenNotice(message: Pick<ChatMessage, "id" | "role" | "metadata">): boolean {
  return isBrowserNoticePrompt(message) && isUnsentBrowserNoticePrompt(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A folded run still represents activity through its last known sent row. */
function activityEnd(message: ChatMessage, start: number): number {
  if (!Array.isArray(message.metadata?.threadMessages)) return start;
  let latest = start;
  const pending: unknown[] = [message];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!isRecord(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (typeof candidate.id !== "string" || (candidate.role !== "assistant" && candidate.role !== "user")) continue;
    const metadata = isRecord(candidate.metadata) ? candidate.metadata : null;
    if (hiddenNotice({ id: candidate.id, role: candidate.role, metadata })) continue;
    const date = sentDate(candidate.timestamp);
    if (date) latest = Math.max(latest, date.getTime());
    if (Array.isArray(metadata?.threadMessages)) {
      for (const child of metadata.threadMessages) pending.push(child);
    }
  }
  return latest;
}

/**
 * Dividers follow the rendered sequence, never a timestamp sort. A small
 * backward clock step cannot invent an idle gap when the clock catches up;
 * local calendar transitions still identify the next visible day's stretch.
 */
export function buildChatTimeDividers(messages: readonly ChatMessage[]): Map<string, number> {
  const dividers = new Map<string, number>();
  let previousStart: Date | null = null;
  let previousActivityEnd: number | null = null;
  for (const message of messages) {
    if (hiddenNotice(message)) continue;
    const start = sentDate(message.timestamp);
    if (!start) continue;
    const timestamp = start.getTime();
    if (!previousStart || !sameLocalDay(previousStart, start) ||
        (previousActivityEnd !== null && timestamp - previousActivityEnd >= IDLE_GAP_MS)) {
      dividers.set(message.id, timestamp);
    }
    previousStart = start;
    previousActivityEnd = Math.max(previousActivityEnd ?? timestamp, activityEnd(message, timestamp));
  }
  return dividers;
}

export function formatChatTimeDivider(timestamp: number, now: number = Date.now()): {
  label: string;
  dateTime: string;
  title: string;
} | null {
  const date = sentDate(timestamp);
  const current = new Date(now);
  if (!date || !Number.isFinite(current.getTime())) return null;
  // Calendar subtraction, not 24 elapsed hours, keeps Yesterday correct
  // across both the short spring day and the long autumn day.
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  const day = sameLocalDay(date, current) ? "Today" : sameLocalDay(date, yesterday) ? "Yesterday" :
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
    }).format(date);
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  return {
    label: `${day} · ${clock}`,
    dateTime: date.toISOString(),
    title: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date),
  };
}
