import type { HTMLAttributes } from "react";

/** A single settings form sits on the page surface; controls own their outlines. */
export function SettingsFormLayout({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={["w-full max-w-2xl space-y-6", className].filter(Boolean).join(" ")} />;
}
