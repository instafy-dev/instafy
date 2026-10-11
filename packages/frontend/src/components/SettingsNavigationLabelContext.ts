import { createContext, useContext, type ReactNode } from "react";

/** Compact category navigation replaces a matching visible content heading. */
export const SettingsNavigationLabelContext = createContext<string | null>(null);

export function useHeadingRepeatedInSettingsNavigation(title: ReactNode): boolean {
  const label = useContext(SettingsNavigationLabelContext);
  return label !== null && typeof title === "string" && title.trim() === label.trim();
}
