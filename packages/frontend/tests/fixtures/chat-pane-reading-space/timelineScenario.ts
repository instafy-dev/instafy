import type { ChatMessage } from "../../../src/screens/studio/types";

// Keep the browser clock and timezone fixed in the visual tests so the local
// day labels stay reproducible without replacing production date formatting.
export const TIMELINE_REVIEW_NOW = "2026-11-02T12:00:00.000Z";
export const TIMELINE_REVIEW_TIMEZONE = "Europe/Vienna";
export const TIMELINE_BOUNDARIES = [
  { id: "timeline-yesterday-user", iso: "2026-11-01T17:10:00.000Z" },
  { id: "timeline-today-user", iso: "2026-11-02T08:05:00.000Z" },
  { id: "timeline-gap-user", iso: "2026-11-02T09:20:00.000Z" },
];

export function timelineMessages(group: boolean): ChatMessage[] {
  const user = (id: string, iso: string, content: string): ChatMessage => ({
    id, role: "user", timestamp: Date.parse(iso), content, authorId: "review-user",
  });
  const octo = (id: string, iso: string, content: string): ChatMessage => ({
    id, role: "assistant", timestamp: Date.parse(iso), content,
    metadata: { agent: { handle: "octo", avatarSeed: "octo" } },
  });
  return [
    user("timeline-yesterday-user", "2026-11-01T17:10:00.000Z", "Can we plan a riverside walk?"),
    octo("timeline-yesterday-assistant", "2026-11-01T17:11:00.000Z", "Yes. I’ll check the route."),
    user("timeline-today-user", "2026-11-02T08:05:00.000Z", "Is the garden open?"),
    octo("timeline-today-assistant", "2026-11-02T08:06:00.000Z", "It opens at ten."),
    user("timeline-gap-user", "2026-11-02T09:20:00.000Z", "And lunch in the old town?"),
    ...(group ? [
      { id: "timeline-peer", role: "user" as const, timestamp: Date.parse("2026-11-02T09:20:15.000Z"), content: "I can join you there.", authorId: "review-teammate" },
      { id: "timeline-planner", role: "assistant" as const, timestamp: Date.parse("2026-11-02T09:20:30.000Z"), content: "The old town is a short walk from the garden.", metadata: { agent: { handle: "route-planner", id: "review-agent-planner", avatarSeed: "review-planner" } } },
    ] : []),
    octo("latest-assistant", "2026-11-02T09:21:00.000Z", "Yes. That fits before the train home."),
  ];
}
