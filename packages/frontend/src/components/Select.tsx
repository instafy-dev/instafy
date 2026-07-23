import { forwardRef } from "react";
import { NavArrowDown } from "iconoir-react";

type ControlSize = "xs" | "sm" | "md" | "lg";
type ControlRadius = "md" | "lg" | "xl" | "2xl" | "full";
type ControlTone = "default" | "muted";

const BASE =
  "appearance-none border text-midnight outline-none transition focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:border-primary-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:text-slate-100 dark:disabled:bg-slate-900 dark:disabled:text-slate-500";

const SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "px-2.5 py-1 text-base sm:text-xs",
  sm: "px-3 py-1.5 text-base sm:text-sm",
  md: "px-3.5 py-2 text-base sm:text-sm",
  lg: "px-4 py-2.5 text-base",
};

const ICON_PADDING: Record<ControlSize, string> = {
  xs: "pr-8",
  sm: "pr-9",
  md: "pr-10",
  lg: "pr-11",
};

const RADIUS_CLASSES: Record<ControlRadius, string> = {
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
};

const TONE_CLASSES: Record<ControlTone, string> = {
  default: "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950",
  muted: "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40",
};

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: ControlSize;
  radius?: ControlRadius;
  tone?: ControlTone;
  fullWidth?: boolean;
  selectClassName?: React.SelectHTMLAttributes<HTMLSelectElement>["className"];
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    size = "sm",
    radius = "xl",
    tone = "default",
    fullWidth = true,
    className,
    selectClassName,
    ...props
  },
  ref
) {
  return (
    <div className={["relative", fullWidth ? "w-full" : "w-fit", className].filter(Boolean).join(" ")}>
      <select
        ref={ref}
        className={[
          BASE,
          SIZE_CLASSES[size],
          ICON_PADDING[size],
          RADIUS_CLASSES[radius],
          TONE_CLASSES[tone],
          "w-full",
          selectClassName,
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      />
      <NavArrowDown
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base text-slate-400 dark:text-slate-500"
        aria-hidden="true"
      />
    </div>
  );
});
