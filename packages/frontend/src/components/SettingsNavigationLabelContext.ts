import { createContext, useContext, type ReactNode } from "react";

/** Only the compact picker replaces a visible content heading. */
export const SettingsNavigationLabelContext = createContext<string | null>(null);

export function useHeadingRepeatedInSettingsNavigation(title: ReactNode): boolean {
  const label = useContext(SettingsNavigationLabelContext);
  return label !== null && typeof title === "string" && title.trim() === label.trim();
}
