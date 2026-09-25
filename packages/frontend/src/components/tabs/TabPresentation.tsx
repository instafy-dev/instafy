import type { ReactNode } from "react";
import { Xmark } from "iconoir-react";
import { IconButton } from "../Button";

export const TAB_FOCUS_CLASS = "outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/40";

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
