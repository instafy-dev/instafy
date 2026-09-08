import { useCallback, useLayoutEffect, useRef } from "react";

const CONTEXT = '[data-testid="sidebar-context-navigation"]';
const REOPEN = '[data-testid="topbar-sidebar-toggle"]';

/** Transfer focus between the mutually exclusive desktop sidebar controls. */
export function useSidebarToggleFocus(isLargeScreen: boolean, sidebarCollapsed: boolean) {
  const sourceRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (!isLargeScreen || !source || source.isConnected ||
      (document.activeElement !== document.body && document.activeElement !== source)) return;
    const target = sidebarCollapsed ? REOPEN : `${CONTEXT} [data-testid="sidebar-drawer-toggle"]`;
    document.querySelector<HTMLButtonElement>(target)?.focus({ preventScroll: true });
  }, [isLargeScreen, sidebarCollapsed]);

  return useCallback(() => {
    const source = document.activeElement;
    sourceRef.current = isLargeScreen && source?.closest(sidebarCollapsed ? REOPEN : CONTEXT)
      ? source : null;
  }, [isLargeScreen, sidebarCollapsed]);
}
