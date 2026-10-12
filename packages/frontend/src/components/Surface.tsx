import type { HTMLAttributes } from "react";
import { DARK_FLOATING_RAISED_BG_CLASS, DARK_FLOATING_SURFACE_CLASS, DARK_FLOATING_SHADOW_CLASS } from "../theme/darkSurfaces";
import { SEMANTIC_TONE_CLASSES, type SemanticTone } from "../theme/semanticTones";

type SurfaceTone = "default" | "floating" | "muted" | "subtle" | "raised" | SemanticTone;
type SurfaceRadius = "none" | "lg" | "xl" | "2xl" | "3xl";
type SurfaceShadow = "none" | "sm" | "md" | "lg";

const BASE = "border text-slate-700 dark:text-slate-200";

const TONE_CLASSES: Record<SurfaceTone, string> = {
  default:
    "border-slate-200 bg-white dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]",
  floating: `border-slate-200/70 bg-white ${DARK_FLOATING_SURFACE_CLASS} ${DARK_FLOATING_SHADOW_CLASS}`,
  muted:
    "border-slate-200/70 bg-slate-50/70 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]",
  subtle:
    "border-slate-200/70 bg-white/95 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-strong)]",
  // For cards nested inside floating surfaces (darkSurfaces.ts rule 5): in dark
  // the fill sits above the popover and the border disappears; light keeps its
  // border because white-on-white has no usable background delta.
  raised: `border-slate-200/70 bg-slate-50/70 dark:border-transparent ${DARK_FLOATING_RAISED_BG_CLASS}`,
  info: SEMANTIC_TONE_CLASSES.info.surface,
  success: SEMANTIC_TONE_CLASSES.success.surface,
  warning: SEMANTIC_TONE_CLASSES.warning.surface,
  danger: SEMANTIC_TONE_CLASSES.danger.surface,
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
