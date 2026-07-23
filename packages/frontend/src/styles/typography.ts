export const textVariants = {
  hero: "text-5xl font-extrabold leading-tight tracking-tight md:text-6xl",
  display: "text-2xl font-semibold tracking-tight",
  section: "text-3xl font-semibold",
  title: "text-xl font-semibold",
  subtitle: "text-base font-medium",
  lead: "text-lg leading-relaxed md:text-xl",
  bodyLg: "text-base leading-relaxed",
  body: "text-sm leading-relaxed",
  bodyStrong: "text-sm font-medium",
  label: "text-xs font-medium uppercase tracking-wide",
  caption: "text-xs",
  overline: "text-xxs font-medium uppercase tracking-[0.2em]",
  mono: "text-xs font-mono",
} as const;

export type TextVariant = keyof typeof textVariants;

export const textTones = {
  primary: "text-midnight dark:text-slate-50",
  secondary: "text-slate-700 dark:text-slate-200",
  muted: "text-slate-500 dark:text-slate-400",
  subtle: "text-slate-400 dark:text-slate-500",
  inherit: "text-inherit",
  inverse: "text-white",
  accent: "text-primary-600 dark:text-primary-400",
  success: "text-primary-600 dark:text-primary-400",
  warning: "text-secondary-700 dark:text-secondary-400",
  danger: "text-rose-600 dark:text-rose-400",
} as const;

export type TextTone = keyof typeof textTones;
