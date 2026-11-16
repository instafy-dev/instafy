import type { HTMLAttributes } from "react";
import { SEMANTIC_TONE_CLASSES, type SemanticTone } from "../theme/semanticTones";

type BadgeTone = "neutral" | SemanticTone;
type BadgeSize = "xs" | "sm";

const BASE = "inline-flex items-center rounded-full border font-medium whitespace-nowrap";

// Pass a tone rather than colour classes: Tailwind orders utilities that set
// the same property by name, not by their place in className, so a caller's
// colour can lose to the tone's own. Neutral text is slate-700, 7.0:1 on its
// slate-100 fill; theme/__tests__/semanticTones.test.ts measures it.
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral:
    "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  success: `${SEMANTIC_TONE_CLASSES.success.surface} ${SEMANTIC_TONE_CLASSES.success.text}`,
  warning: `${SEMANTIC_TONE_CLASSES.warning.surface} ${SEMANTIC_TONE_CLASSES.warning.text}`,
  danger: `${SEMANTIC_TONE_CLASSES.danger.surface} ${SEMANTIC_TONE_CLASSES.danger.text}`,
  info: `${SEMANTIC_TONE_CLASSES.info.surface} ${SEMANTIC_TONE_CLASSES.info.text}`,
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  xs: "px-2 py-0.5 text-3xs",
  sm: "px-2.5 py-1 text-xs",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  size?: BadgeSize;
};

export function Badge({ tone = "neutral", size = "xs", className, ...props }: BadgeProps) {
  return (
    <span
      className={[BASE, TONE_CLASSES[tone], SIZE_CLASSES[size], className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
