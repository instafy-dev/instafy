import { DARK_ACTIVE_SURFACE_CLASS, DARK_RAISED_CONTROL_BG_CLASS } from "../theme/darkSurfaces";

type SegmentedControlTone = "default" | "inverse";

/** Shared geometry for navigation categories and mutually exclusive form choices. */
export function segmentedControlGroupClassName(tone: SegmentedControlTone = "default"): string {
  return [
    "flex min-w-0 items-center gap-1 rounded-xl p-1",
    tone === "inverse" ? "bg-black/20" : `bg-slate-100/70 ${DARK_RAISED_CONTROL_BG_CLASS}`,
  ].join(" ");
}

/** Consumers choose width and minimum height; selection and focus stay consistent. */
export function segmentedControlOptionClassName(selected: boolean, tone: SegmentedControlTone = "default"): string {
  return [
    "group/segment relative inline-flex min-w-0 items-center justify-center gap-1 rounded-lg border font-medium outline-none touch-manipulation [-webkit-tap-highlight-color:transparent] transition-[color,background-color,border-color,box-shadow] data-[disabled]:pointer-events-none data-[disabled]:opacity-60 disabled:pointer-events-none disabled:opacity-60",
    selected
      ? tone === "inverse"
        ? "border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.12)] text-slate-50 shadow-sm"
        : `border-slate-200/80 bg-white text-slate-900 shadow-sm ${DARK_ACTIVE_SURFACE_CLASS} dark:text-slate-50`
      : tone === "inverse"
        ? "border-transparent bg-transparent text-slate-300 hover:text-slate-50 data-[hovered]:text-slate-50"
        : "border-transparent bg-transparent text-slate-600 hover:text-slate-900 data-[hovered]:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100",
  ].join(" ");
}

/** React Aria's keyboard modality owns the single, label-sized focus indicator. */
export const SEGMENTED_CONTROL_LABEL_CLASS =
  "max-w-full truncate rounded-sm px-2 py-1 group-data-[focus-visible]/segment:outline-2 group-data-[focus-visible]/segment:outline-offset-2 group-data-[focus-visible]/segment:outline-primary-600 dark:group-data-[focus-visible]/segment:outline-primary-400";
