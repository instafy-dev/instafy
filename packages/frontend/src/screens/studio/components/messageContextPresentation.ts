import type { ChatMessage } from "../types";

/** Keep the stored match visible even when the ordinary transcript groups or hides its event. */
export function revealCanonicalMessageTarget(displayed: ChatMessage[], messages: ChatMessage[], targetId: string | null): ChatMessage[] {
  if (!targetId) return displayed;
  const target = messages.find((message) => message.id === targetId);
  if (!target) return displayed;
  const index = displayed.findIndex((message) => message.id === targetId);
  if (index >= 0) return displayed.map((message) => message.id === targetId ? target : message);
  const next = [...displayed];
  const insertAt = next.findIndex((message) => message.timestamp > target.timestamp);
  next.splice(insertAt < 0 ? next.length : insertAt, 0, target);
  return next;
}
