import type { HTMLAttributes } from "react";

type SurfaceTone = "default" | "muted" | "subtle" | "success" | "warning" | "danger";
type SurfaceRadius = "none" | "lg" | "xl" | "2xl" | "3xl";
type SurfaceShadow = "none" | "sm" | "md" | "lg";

const BASE = "border text-slate-700 dark:text-slate-200";

const TONE_CLASSES: Record<SurfaceTone, string> = {
  default:
    "border-slate-200 bg-white dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]",
  muted:
    "border-slate-200/70 bg-slate-50/70 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]",
  subtle:
    "border-slate-200/70 bg-white/95 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-strong)]",
  success: "border-primary-200/80 bg-primary-50/80 dark:border-primary-500/40 dark:bg-primary-500/10",
  warning: "border-secondary-200/80 bg-secondary-50/80 dark:border-secondary-500/40 dark:bg-secondary-500/10",
  danger: "border-rose-200/80 bg-rose-50/80 dark:border-rose-500/40 dark:bg-rose-500/10",
};

const RADIUS_CLASSES: Record<SurfaceRadius, string> = {
  none: "",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  "3xl": "rounded-3xl",
};

const SHADOW_CLASSES: Record<SurfaceShadow, string> = {
  none: "",
  sm: "shadow-sm",
  md: "shadow-md",
  lg: "shadow-lg",
};

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  tone?: SurfaceTone;
  radius?: SurfaceRadius;
  shadow?: SurfaceShadow;
};

export function Surface({
  tone = "default",
  radius = "2xl",
  shadow = "sm",
  className,
  ...props
}: SurfaceProps) {
  return (
    <div
      className={[
        BASE,
        TONE_CLASSES[tone],
        RADIUS_CLASSES[radius],
        SHADOW_CLASSES[shadow],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
