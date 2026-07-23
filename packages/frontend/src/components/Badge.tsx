import type { HTMLAttributes } from "react";

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";
type BadgeSize = "xs" | "sm";

const BASE = "inline-flex items-center rounded-full border font-medium whitespace-nowrap";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral:
    "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  success:
    "border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-200",
  warning:
    "border-secondary-200 bg-secondary-50 text-secondary-700 dark:border-secondary-500/40 dark:bg-secondary-500/10 dark:text-secondary-200",
  danger:
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200",
  info:
    "border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-200",
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
