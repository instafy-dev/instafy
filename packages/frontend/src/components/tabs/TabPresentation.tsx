import type { ReactNode } from "react";
import { Xmark } from "iconoir-react";
import { IconButton } from "../Button";
import { DARK_RAIL_HOVER_CLASS } from "../../theme/darkSurfaces";

export const TAB_FOCUS_CLASS = "outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/40";

export type TabPreset = "contained" | "underline";

// Tab geometry and state styling belong together. Contained tabs keep their
// selected surface and focus ring on the same 12px curve; underline tabs retain
// the compact header treatment. Tab owners still supply semantics and behavior.
const TAB_PRESETS = {
  contained: {
    item: "rounded-xl",
    selectedItem: "bg-white dark:bg-slate-700",
    trigger: "flex-1 justify-center rounded-xl text-sm aria-selected:font-medium aria-selected:text-primary-700 dark:aria-selected:text-primary-300 forced-colors:aria-selected:outline forced-colors:aria-selected:outline-solid forced-colors:aria-selected:outline-[Highlight]",
  },
  underline: {
    item: "",
    selectedItem: "",
    trigger: "text-xs hover:bg-slate-100/80 after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-[1.5px] after:rounded-full aria-selected:after:bg-primary-600 dark:aria-selected:after:bg-primary-400 forced-colors:aria-selected:after:bg-[Highlight] pointer-coarse:max-w-40",
  },
} as const satisfies Record<TabPreset, { item: string; selectedItem: string; trigger: string }>;

/** The visual tab item can contain both its trigger and an independent close action. */
export function tabItemStyles(preset: TabPreset, selected: boolean): string {
  return [
    "flex shrink-0 items-center",
    TAB_PRESETS[preset].item,
    selected ? TAB_PRESETS[preset].selectedItem : "",
    selected ? "text-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400",
  ].filter(Boolean).join(" ");
}

export function tabTriggerStyles(preset: TabPreset): string {
  return [
    "relative flex min-h-11 max-w-52 items-center gap-1.5 px-3",
    TAB_PRESETS[preset].trigger,
    DARK_RAIL_HOVER_CLASS,
    TAB_FOCUS_CLASS,
  ].join(" ");
}

/** Shared content; routing, selection and drag behavior belong to each tab owner. */
export function TabLabel({ label, icon, dirty, preview, children }: {
  label: string;
  icon?: ReactNode;
  dirty?: boolean;
  preview?: boolean;
  children?: ReactNode;
}) {
  return <>
    {icon ? <span aria-hidden="true" className="shrink-0">{icon}</span> : null}
    <span className={`min-w-0 flex-1 truncate ${preview ? "italic" : ""}`}>{label}</span>
    {children}
    {dirty ? <span className="shrink-0 text-xs text-rose-400" role="img" aria-label="Unsaved changes">●</span> : null}
  </>;
}

export function TabCloseButton({ label, onClose, className = "" }: {
  label: string;
  onClose: () => void;
  className?: string;
}) {
  return <IconButton
    type="button" aria-label={label} title={label}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onClose(); }}
    variant="ghost" size="xs" radius="full"
    className={`${className} focus-visible:ring-offset-0`}
  ><Xmark className="h-3.5 w-3.5" aria-hidden="true" /></IconButton>;
}
