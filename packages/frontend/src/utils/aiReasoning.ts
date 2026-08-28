// Reasoning-effort levels an agent can run at. These mirror the values the
// proxy accepts (`reasoning.effort`) and the runtime maps onto the Codex
// `ReasoningEffort` enum. `null` means "inherit" — the runtime falls back to
// its per-job heuristic / the global default.

export type AiReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface AiReasoningOption {
  id: AiReasoningEffort;
  label: string;
}

// Ordered low→high so the menu reads as a natural ramp.
export const REASONING_EFFORT_OPTIONS: AiReasoningOption[] = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

const VALID = new Set<string>(REASONING_EFFORT_OPTIONS.map((option) => option.id));

/** Coerce an arbitrary value to a known effort level, or null if unrecognized. */
export function normalizeReasoningEffort(value: unknown): AiReasoningEffort | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID.has(normalized) ? (normalized as AiReasoningEffort) : null;
}

/** Display label for an effort level (falls back to the raw id). */
export function reasoningEffortLabel(value: AiReasoningEffort): string {
  return REASONING_EFFORT_OPTIONS.find((option) => option.id === value)?.label ?? value;
}
