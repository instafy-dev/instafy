import type { HTMLAttributes } from "react";

export type SpinnerTone = "slate" | "primary" | "secondary" | "rose";
export type SpinnerSize = "xs" | "sm" | "md";

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  tone?: SpinnerTone;
  size?: SpinnerSize;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
};

const TONE_CLASSES: Record<SpinnerTone, string> = {
  slate: "border-slate-300 border-t-slate-500 dark:border-slate-700 dark:border-t-slate-400",
  primary: "border-primary-200 border-t-primary-500 dark:border-primary-500/30 dark:border-t-primary-400",
  secondary: "border-secondary-200 border-t-secondary-500 dark:border-secondary-500/30 dark:border-t-secondary-300",
  rose: "border-rose-200 border-t-rose-500 dark:border-rose-500/30 dark:border-t-rose-300",
};

export function Spinner({ tone = "slate", size = "sm", className, ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      className={[
        "inline-block shrink-0 animate-spin rounded-full border-2",
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
