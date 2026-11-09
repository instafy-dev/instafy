import type { HTMLAttributes } from "react";
import { DARK_RAISED_CONTROL_CLASS } from "../../../theme/darkSurfaces";
import { SEMANTIC_TONE_CLASSES } from "../../../theme/semanticTones";

type BrowserStateTone = "neutral" | "success" | "danger" | "agent";

const TONE_CLASSES: Record<BrowserStateTone, string> = {
  neutral: `border-slate-300/80 bg-slate-100/80 text-slate-600 dark:text-slate-300 ${DARK_RAISED_CONTROL_CLASS}`,
  success: `${SEMANTIC_TONE_CLASSES.success.surface} ${SEMANTIC_TONE_CLASSES.success.text}`,
  danger: `${SEMANTIC_TONE_CLASSES.danger.surface} ${SEMANTIC_TONE_CLASSES.danger.text}`,
  // Violet identifies the agent holding a browser; it is not an outcome tone.
  agent: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

/** Noninteractive browser state/ownership marks share geometry. Owners supply announcements. */
export function BrowserStateBadge({
  tone = "neutral",
  compact = false,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BrowserStateTone; compact?: boolean }) {
  return <span
    {...props}
    className={[
      "inline-flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-full border text-xxs font-medium",
      compact ? "px-1.5" : "px-2",
      TONE_CLASSES[tone],
      className,
    ].filter(Boolean).join(" ")}
  />;
}
