// Single source of truth for chat bubble / card max-widths.
//
// Each tier pairs a desktop readable cap (rem) with the narrow-viewport
// percentage floor that keeps the bubble off the panel edge. These values were
// consolidated from per-site literals scattered across the chat components so
// message, notice, alert, card, status and activity bubbles read as one scale
// instead of a zoo of one-off widths. Values are preserved exactly — the
// mobile (≤sm) geometry is intentionally coherent — so editing a tier here
// re-tunes every bubble of that kind at once. Any *rationalisation* of the
// values (fewer distinct widths) is a deliberate visual change and should be
// made here with a design pass, not ad hoc at a call site.
export const CHAT_BUBBLE_MAX_WIDTH = {
  /** User message bubble (hugs its content). */
  message: "max-w-[min(92%,56rem)]",
  /** Assistant / full-width message. */
  messageFull: "max-w-[56rem]",
  /** Informational notices and activity lines. */
  notice: "max-w-[min(100%,42rem)]",
  /** Errors and credential prompts. */
  alert: "max-w-[min(80%,42rem)]",
  /** Contained action / credential cards (important beats the row reset). */
  card: "!max-w-[min(100%,38rem)]",
  /** Compact status bubble. */
  status: "max-w-[min(85%,30rem)]",
  /** Inline activity bubble (assistant side). */
  activity: "max-w-full sm:max-w-[26rem]",
  /** Inline activity bubble (peer side). */
  activityPeer: "max-w-[60%]",
  /** Getting-started intro card. */
  intro: "max-w-none sm:max-w-[min(560px,90%)]",
} as const;
