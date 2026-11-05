import type { HTMLAttributes } from "react";
import { CONTROL_RADIUS_CLASSES } from "../../../components/controlStyles";

/** Shared scope-token surface; each owner arranges its label, picker and removal action. */
export function StudioSearchScopeChip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={[
    "inline-flex items-center min-w-0 bg-slate-100 dark:bg-[var(--color-studio-dark-active)]",
    CONTROL_RADIUS_CLASSES.lg,
    className,
  ].filter(Boolean).join(" ")} />;
}
