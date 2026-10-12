import { SEMANTIC_TONE_CLASSES } from "../theme/semanticTones";

export const textVariants = {
  hero: "text-5xl font-extrabold leading-tight tracking-tight md:text-6xl",
  display: "text-2xl font-semibold tracking-tight",
  section: "text-3xl font-semibold",
  title: "text-xl font-semibold",
  titleCompact: "text-lg font-medium",
  subtitle: "text-base font-medium",
  subtitleStrong: "text-base font-semibold leading-5 tracking-tight",
  lead: "text-lg leading-relaxed md:text-xl",
  bodyLg: "text-base leading-relaxed",
  body: "text-sm leading-relaxed",
  bodyCompact: "text-sm leading-5",
  bodyRoomy: "text-sm leading-6",
  bodyStrong: "text-sm font-medium",
  fieldLabel: "text-[13px] font-medium leading-[18px]",
  label: "text-xs font-medium uppercase tracking-wide",
  caption: "text-xs",
  captionStrong: "text-xs font-medium",
  captionSmall: "text-xxs",
  captionSmallStrong: "text-xxs font-medium",
  overline: "text-xxs font-medium uppercase tracking-[0.2em]",
  mono: "text-xs font-mono",
} as const;

export type TextVariant = keyof typeof textVariants;

export const textTones = {
  primary: "text-midnight dark:text-slate-50",
  secondary: "text-slate-700 dark:text-slate-200",
  muted: "text-slate-600 dark:text-slate-400",
  subtle: "text-slate-400 dark:text-slate-500",
  inherit: "text-inherit",
  inverse: "text-white",
  accent: SEMANTIC_TONE_CLASSES.info.text,
  info: SEMANTIC_TONE_CLASSES.info.text,
  success: SEMANTIC_TONE_CLASSES.success.text,
  warning: SEMANTIC_TONE_CLASSES.warning.text,
  danger: SEMANTIC_TONE_CLASSES.danger.text,
} as const;

export type TextTone = keyof typeof textTones;
