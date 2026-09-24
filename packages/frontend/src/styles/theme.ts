export const theme = {
  page: {
    gradient: "bg-gradient-to-br from-primary-50 via-white to-secondary-100",
  },
  surface: {
    card: "rounded-3xl border border-slate-200 bg-white/95 shadow-xl shadow-slate-200/70 dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-none",
  },
  text: {
    primary: "text-slate-900",
    secondary: "text-slate-600",
    subtle: "text-slate-500",
    accent: "text-primary-600",
  },
  input:
    "rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base text-slate-800 placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 sm:text-sm",
  button: {
    primary:
      [
        "inline-flex items-center justify-center whitespace-nowrap",
        "rounded-full bg-primary-600",
        "px-6 py-3 text-sm font-semibold text-white",
        "shadow-md shadow-primary-900/10 dark:shadow-black/30",
        "transition hover:bg-primary-700",
        "disabled:cursor-not-allowed disabled:opacity-60",
      ].join(" "),
    secondary:
      [
        "inline-flex items-center justify-center whitespace-nowrap",
        "rounded-full border border-slate-300 bg-white px-5 py-2",
        "text-sm font-semibold leading-none text-slate-600",
        "transition hover:border-slate-400 hover:text-slate-800",
        "dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-200",
        "dark:hover:border-slate-600 dark:hover:bg-slate-950 dark:hover:text-slate-50",
        "disabled:cursor-not-allowed disabled:opacity-60",
      ].join(" "),
    toggleBase: "flex-1 rounded-full px-4 py-2 text-xs font-semibold transition",
    toggleActive: "bg-primary-100 text-primary-700 shadow-sm",
    toggleInactive: "text-slate-500 hover:bg-primary-50 hover:text-primary-600",
  },
};
