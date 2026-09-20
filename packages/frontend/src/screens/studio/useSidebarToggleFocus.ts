import { useCallback, useLayoutEffect, useRef } from "react";

const CONTEXT = '[data-testid="sidebar-context-navigation"]';
const FOCUS_SOURCE = `${CONTEXT}, [data-testid="sidebar-recent-chats-popover"], [data-testid="sidebar-recent-spaces-popover"], [data-testid="sidebar-more-menu"], [data-testid="sidebar-team-menu"]`;
/** Keep focus in the desktop rail if changing width removes its focused detail. */
export function useSidebarToggleFocus(isLargeScreen: boolean, sidebarCollapsed: boolean) {
  const sourceRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (!isLargeScreen || !source || source.isConnected ||
      (document.activeElement !== document.body && document.activeElement !== source)) return;
    const target = `${CONTEXT} [data-testid="sidebar-drawer-toggle"]`;
    document.querySelector<HTMLButtonElement>(target)?.focus({ preventScroll: true });
  }, [isLargeScreen, sidebarCollapsed]);

  return useCallback(() => {
    const source = document.activeElement;
    sourceRef.current = isLargeScreen && source?.closest(FOCUS_SOURCE)
      ? source : null;
  }, [isLargeScreen]);
}
