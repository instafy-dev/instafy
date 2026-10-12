export type SemanticTone = "info" | "success" | "warning" | "danger";

// Semantic meaning stays the same across text, badges, notices and larger surfaces.
// Keep these classes static so Tailwind can discover every light/dark state.
export const SEMANTIC_TONE_CLASSES = {
  info: {
    surface: "border-primary-200/80 bg-primary-50/70 dark:border-primary-500/30 dark:bg-primary-500/10",
    text: "text-primary-600 dark:text-primary-400",
    icon: "text-primary-600 dark:text-primary-300",
  },
  success: {
    surface: "border-emerald-200/80 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: "text-emerald-600 dark:text-emerald-300",
  },
  warning: {
    surface: "border-secondary-200/80 bg-secondary-50/70 dark:border-secondary-500/30 dark:bg-secondary-500/10",
    text: "text-secondary-700 dark:text-secondary-400",
    icon: "text-secondary-600 dark:text-secondary-300",
  },
  danger: {
    surface: "border-rose-200/80 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/10",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-600 dark:text-rose-300",
  },
} as const satisfies Record<SemanticTone, { surface: string; text: string; icon: string }>;
