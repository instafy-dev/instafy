import type { HTMLAttributes } from "react";

/** A single settings form sits on the page surface; controls own their outlines. */
export function SettingsFormLayout({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={["w-full max-w-2xl space-y-6", className].filter(Boolean).join(" ")} />;
}

/** Keep the identity and its name together, including in narrow settings panes. */
export function SettingsIdentityRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={["grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4", className].filter(Boolean).join(" ")} />;
}
