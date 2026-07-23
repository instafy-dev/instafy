import { forwardRef } from "react";

type ControlSize = "xs" | "sm" | "md" | "lg";
type ControlRadius = "md" | "lg" | "xl" | "2xl";
type ControlTone = "default" | "muted" | "ghost";

const BASE =
  "border text-midnight placeholder:text-slate-400 outline-none transition focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:border-primary-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-[var(--color-studio-dark-active)] dark:disabled:text-slate-500";

const UNSTYLED_BASE =
  "bg-transparent text-midnight placeholder:text-slate-400 outline-none disabled:cursor-not-allowed disabled:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:text-slate-500";

const SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "px-2.5 py-1 text-base sm:text-xs",
  sm: "px-3 py-1.5 text-base sm:text-sm",
  md: "px-3.5 py-2 text-base sm:text-sm",
  lg: "px-4 py-2.5 text-base",
};

const RADIUS_CLASSES: Record<ControlRadius, string> = {
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
};

const TONE_CLASSES: Record<ControlTone, string> = {
  default:
    "border-slate-200 bg-white dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)]",
  muted:
    "border-slate-200 bg-slate-50 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]",
  ghost: "border-transparent bg-transparent",
};

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  size?: ControlSize;
  radius?: ControlRadius;
  tone?: ControlTone;
  fullWidth?: boolean;
  unstyled?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    size = "sm",
    radius = "xl",
    tone = "default",
    fullWidth = true,
    unstyled = false,
    className,
    ...props
  },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={
        unstyled
          ? [UNSTYLED_BASE, fullWidth ? "w-full" : "", className].filter(Boolean).join(" ")
          : [
              BASE,
              SIZE_CLASSES[size],
              RADIUS_CLASSES[radius],
              TONE_CLASSES[tone],
              fullWidth ? "w-full" : "",
              className,
            ]
              .filter(Boolean)
              .join(" ")
      }
      {...props}
    />
  );
});
