/** Shared sizing and surfaces for native and app-rendered form controls. */
export type ControlSize = "xs" | "sm" | "md" | "lg";
export type ControlRadius = "md" | "lg" | "xl" | "2xl" | "full";
export type ControlTone = "default" | "muted" | "ghost";

export const CONTROL_DEFAULT_SIZE: ControlSize = "md";
export const FORM_CONTROL_HEIGHT = "min-h-11 sm:pointer-fine:min-h-[38px]";

/** React Aria form buttons share the input surface without action-button styles. */
export const CONTROL_TRIGGER_BASE =
  "min-w-0 flex items-center border text-left text-midnight outline-none transition pointer-coarse:min-h-11 data-[focus-visible]:ring-2 data-[focus-visible]:ring-primary-400/40 data-[focus-visible]:border-primary-400 data-[disabled]:cursor-not-allowed data-[disabled]:bg-slate-100 data-[disabled]:text-slate-400 dark:text-slate-100 dark:data-[disabled]:bg-[var(--color-studio-dark-active)] dark:data-[disabled]:text-slate-500";

export const CONTROL_SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "px-2.5 py-1 text-base sm:text-xs",
  sm: "px-3 py-1.5 text-base sm:text-sm",
  md: `${FORM_CONTROL_HEIGHT} px-3 py-2 text-base sm:text-sm`,
  lg: "px-4 py-2.5 text-base",
};

export const CONTROL_RADIUS_CLASSES: Record<ControlRadius, string> = {
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
};

export const CONTROL_TONE_CLASSES: Record<ControlTone, string> = {
  default:
    "border-slate-200 bg-white dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)]",
  muted:
    "border-slate-200 bg-slate-50 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]",
  ghost: "border-transparent bg-transparent",
};
