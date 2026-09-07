export const textVariants = {
  hero: "text-5xl font-extrabold leading-tight tracking-tight md:text-6xl",
  display: "text-2xl font-semibold tracking-tight",
  section: "text-3xl font-semibold",
  title: "text-xl font-semibold",
  subtitle: "text-base font-medium",
  lead: "text-lg leading-relaxed md:text-xl",
  bodyLg: "text-base leading-relaxed",
  body: "text-body",
  bodyStrong: "text-sm font-medium",
  control: "text-sm leading-5",
  label: "text-xs font-medium uppercase tracking-wide",
  caption: "text-xs",
  overline: "text-xxs font-medium uppercase tracking-[0.2em]",
  mono: "text-xs font-mono",
} as const;

// Text-entry controls keep 16px text on phones. Compact desktop controls
// and the composer use 20px lines; their geometry is separate from prose.
export const textControlSizes = {
  xs: "text-base leading-5 sm:text-xs sm:leading-4",
  sm: "text-base leading-5 sm:text-sm",
  md: "text-base leading-5 sm:text-sm",
  lg: "text-base",
} as const;

// Monaco also draws text on canvas, where a CSS var() font family is invalid.
// Resolve the shared token before giving it to the editor's font measurements.
export function resolveMonospaceFontFamily(): string {
  if (typeof window === "undefined") return "monospace";
  return window.getComputedStyle(window.document.documentElement)
    .getPropertyValue("--font-mono").trim() || "monospace";
}

export type TextVariant = keyof typeof textVariants;

export const textTones = {
  primary: "text-midnight dark:text-slate-50",
  secondary: "text-slate-700 dark:text-slate-200",
  muted: "text-slate-600 dark:text-slate-400",
  subtle: "text-slate-400 dark:text-slate-500",
  inherit: "text-inherit",
  inverse: "text-white",
  accent: "text-primary-600 dark:text-primary-400",
  success: "text-primary-600 dark:text-primary-400",
  warning: "text-secondary-700 dark:text-secondary-400",
  danger: "text-rose-600 dark:text-rose-400",
} as const;

export type TextTone = keyof typeof textTones;
