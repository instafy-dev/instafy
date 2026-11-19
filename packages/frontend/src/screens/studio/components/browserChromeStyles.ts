import { DARK_DIVIDER_BORDER_CLASS, DARK_PANEL_SOFT_BG_CLASS } from "../../../theme/darkSurfaces";

/** Browser toolbars share a quiet surface; each owner keeps its viewport geometry. */
export const BROWSER_TOOLBAR_SURFACE_CLASS =
  `bg-slate-50 text-slate-700 dark:text-slate-200 ${DARK_PANEL_SOFT_BG_CLASS}`;

export const BROWSER_TOOLBAR_DIVIDER_CLASS = `border-b border-slate-200 ${DARK_DIVIDER_BORDER_CLASS}`;
