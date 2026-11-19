// Mentions render both as React spans and as Lexical-owned DOM nodes. Keep
// their geometry and identity colors shared without wrapping editable nodes.
const MENTION_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 font-semibold leading-none ring-1 align-baseline";

export const MENTION_CLASSES = {
  agent: `${MENTION_BASE} bg-secondary-50 text-secondary-800 ring-secondary-200 dark:bg-secondary-500/15 dark:text-secondary-200 dark:ring-secondary-500/30`,
  person: `${MENTION_BASE} bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/70 dark:text-slate-100 dark:ring-slate-700`,
} as const;
