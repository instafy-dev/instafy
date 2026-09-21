export const LIST_ROW_SURFACE_BASE =
  "group rounded-xl border border-transparent transition-colors";

export const LIST_ROW_SURFACE_IDLE =
  "hover:bg-slate-50 dark:hover:bg-[var(--color-studio-dark-rail-hover)]";

export const LIST_ROW_SURFACE_ACTIVE =
  "border-transparent !bg-slate-100 dark:!bg-[var(--color-studio-dark-active)]";

export const LIST_ROW_FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)]";

export const LIST_ROW_FOCUS_WITHIN_RING =
  "focus-within:ring-2 focus-within:ring-primary-400/35 focus-within:ring-offset-2 focus-within:ring-offset-white dark:focus-within:ring-offset-[var(--color-studio-dark-rail)]";

export const DRAWER_SECTION_HEADER_BASE = "flex items-center justify-between gap-2 px-1";

export const DRAWER_SECTION_LABEL_CLASS = "text-xxs tracking-[0.12em]";

export const DRAWER_LIST_ROW_TEXT_CLASS = "text-sm leading-5";

// Selection in navigation pickers is a flat fill; keyboard focus keeps its own ring.
export const PICKER_LIST_ROW_ACTIVE_CLASS =
  "bg-slate-100 dark:bg-[var(--color-studio-dark-active)]";

// Compact navigation lists share row geometry, with larger targets on phones and touch screens.
export const PICKER_LIST_ROW_GEOMETRY_CLASS =
  "min-h-9 rounded-xl px-3.5 py-2 max-[900px]:min-h-11 pointer-coarse:min-h-11";

export function pickerListRowTextClassName(active: boolean): string {
  return active
    ? "!font-medium !text-slate-900 dark:!text-slate-50"
    : "!font-normal !text-slate-700 dark:!text-slate-200";
}

export const DRAWER_LIST_ROW_META_CLASS = "text-xs text-slate-500 dark:text-slate-400";

export const DRAWER_ICON_BUTTON_TONE_CLASS =
  "text-slate-500 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-400 dark:hover:bg-[var(--color-studio-dark-rail-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-rail-hover)]";

export function listRowSurfaceToneClassName(active: boolean): string {
  return active ? LIST_ROW_SURFACE_ACTIVE : LIST_ROW_SURFACE_IDLE;
}
