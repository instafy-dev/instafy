import { createContext, useContext, type ReactNode } from "react";

/** The enclosing navigation already renders the page's visible, semantic title.
 * Only page headings opt in; section headings and embedded drawers keep theirs. */
export const PageTitleInNavigationContext = createContext<string | null>(null);

export function usePageTitleInNavigation(title?: ReactNode): boolean {
  const navigationTitle = useContext(PageTitleInNavigationContext);
  return navigationTitle !== null && (title === undefined || (
    typeof title === "string" && title.trim() === navigationTitle.trim()
  ));
}
