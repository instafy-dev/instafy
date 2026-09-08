import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getStudioVisitKey } from "../navigation/studioVisit";

export type MobileSidebarView = "sidebar" | "workspace" | "more";
interface SidebarEntry {
  version: 1;
  scopeKey: string;
  baseKey: string;
  baseIndex: number;
  depth: 1 | 2;
  view: MobileSidebarView;
}
export const MOBILE_SIDEBAR_STATE_KEY = "instafySidebar";
const TRANSITION_TIMEOUT_MS = 2_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function stripMobileSidebarState(state: unknown): Record<string, unknown> {
  const next = { ...record(state) };
  delete next[MOBILE_SIDEBAR_STATE_KEY];
  return next;
}

export function readMobileSidebarEntry(
  state: unknown,
  scopeKey: string | null,
  historyIndex: unknown,
): SidebarEntry | null {
  const value = record(record(state)[MOBILE_SIDEBAR_STATE_KEY]);
  if (!scopeKey || value.version !== 1 || value.scopeKey !== scopeKey ||
      typeof value.baseKey !== "string" || !value.baseKey || value.baseKey.length > 128 ||
      !Number.isSafeInteger(value.baseIndex) || (value.baseIndex as number) < 0 ||
      (value.depth !== 1 && value.depth !== 2) ||
      (value.depth === 1 ? value.view !== "sidebar" : value.view !== "workspace" && value.view !== "more") ||
      historyIndex !== (value.baseIndex as number) + value.depth) return null;
  return value as unknown as SidebarEntry;
}

export interface MobileSidebarNavigation {
  view: MobileSidebarView | null;
  pending: boolean;
  error: string | null;
  openView: (view: MobileSidebarView) => void;
  back: () => void;
}

/** Drawers are real same-destination visits. Destination selection first returns
 * to the exact owned base, then pushes once, truncating the obsolete drawer branch. */
export function useMobileSidebarHistory({ enabled, scopeKey }: { enabled: boolean; scopeKey: string | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const historyIndex = typeof window === "undefined" ? null : window.history.state?.idx;
  const entry = readMobileSidebarEntry(location.state, scopeKey, historyIndex);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef({ location, scopeKey, entry, enabled });
  current.current = { location, scopeKey, entry, enabled };
  const transition = useRef<{
    sourceKey: string;
    baseKey: string;
    baseIndex: number;
    scopeKey: string;
    action?: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const cancel = useCallback((message: string | null = null) => {
    if (transition.current) clearTimeout(transition.current.timer);
    transition.current = null;
    setPending(false);
    setError(message);
  }, []);

  const collapse = useCallback((action?: () => void) => {
    const state = current.current;
    if (transition.current) return;
    setError(null);
    if (!state.entry) {
      // Direct destination clicks may precede Router's next render. They need no
      // overlay traversal, but must not bypass a just-pushed, unrendered drawer.
      const liveEntry = readMobileSidebarEntry(window.history.state?.usr, state.scopeKey, window.history.state?.idx);
      if (state.scopeKey && !liveEntry) action?.();
      return;
    }
    if ((window.history.state?.key ?? "default") !== state.location.key) return;
    const request = {
      sourceKey: state.location.key,
      baseKey: state.entry.baseKey,
      baseIndex: state.entry.baseIndex,
      scopeKey: state.entry.scopeKey,
      action,
      timer: setTimeout(() => {
        if (transition.current === request) cancel("Navigation did not finish. Please try again.");
      }, TRANSITION_TIMEOUT_MS),
    };
    transition.current = request;
    setPending(true);
    navigate(-state.entry.depth);
  }, [cancel, navigate]);

  useLayoutEffect(() => {
    const request = transition.current;
    if (!request) return;
    if (scopeKey !== request.scopeKey) {
      cancel();
      return;
    }
    if (location.key === request.sourceKey) return;
    if (location.key !== request.baseKey || window.history.state?.idx !== request.baseIndex) {
      cancel();
      return;
    }
    // Let all route hydration finish before a new destination action. A later
    // gesture/account switch must cancel this continuation, never redirect it.
    clearTimeout(request.timer);
    queueMicrotask(() => {
      if (transition.current !== request) return;
      const latest = current.current;
      if (latest.scopeKey !== request.scopeKey ||
          latest.location.key !== request.baseKey ||
          (window.history.state?.key ?? "default") !== request.baseKey ||
          window.history.state?.idx !== request.baseIndex) {
        cancel();
        return;
      }
      transition.current = null;
      setPending(false);
      request.action?.();
    });
  }, [cancel, location.key, scopeKey]);

  // A breakpoint change closes the mobile branch just like the close button.
  // Leaving hidden entries underneath a desktop destination would resurrect an
  // old drawer when the user later returns to a narrow viewport and goes Back.
  useEffect(() => {
    if (!enabled && current.current.entry) collapse();
  }, [collapse, enabled, location.key, scopeKey]);

  useEffect(() => () => {
    if (transition.current) clearTimeout(transition.current.timer);
    transition.current = null;
  }, []);

  const openView = useCallback((view: MobileSidebarView) => {
    const state = current.current;
    if (!state.enabled || !state.scopeKey || transition.current || state.entry?.view === view) return;
    if ((window.history.state?.key ?? "default") !== state.location.key) return;
    const index = window.history.state?.idx;
    if (!Number.isSafeInteger(index) || index < 0 || !state.location.key) {
      setError("Navigation is not ready. Please try again.");
      return;
    }
    if (view !== "sidebar" && !state.entry) return;
    if (view === "sidebar" && state.entry) {
      navigate(-1);
      return;
    }
    const next: SidebarEntry = {
      version: 1,
      scopeKey: state.scopeKey,
      baseKey: state.entry?.baseKey ?? state.location.key,
      baseIndex: state.entry?.baseIndex ?? index,
      depth: view === "sidebar" ? 1 : 2,
      view,
    };
    setError(null);
    navigate({ pathname: state.location.pathname, search: state.location.search, hash: state.location.hash }, {
      replace: state.entry?.depth === 2,
      state: {
        ...record(state.location.state),
        instafyVisitKey: getStudioVisitKey(state.location),
        [MOBILE_SIDEBAR_STATE_KEY]: next,
      },
    });
  }, [navigate]);

  const back = useCallback(() => {
    const state = current.current;
    if (state.entry && !transition.current &&
        (window.history.state?.key ?? "default") === state.location.key) navigate(-1);
  }, [navigate]);
  const setOpen = useCallback((update: SetStateAction<boolean>) => {
    const isOpen = current.current.entry !== null;
    const next = typeof update === "function" ? update(isOpen) : update;
    if (next && !isOpen) openView("sidebar");
    else if (!next && isOpen) collapse();
  }, [collapse, openView]);

  return {
    mobileSidebarOpen: enabled && entry !== null,
    setMobileSidebarOpen: setOpen,
    mobileSidebarNavigation: { view: enabled ? entry?.view ?? null : null, pending, error, openView, back } satisfies MobileSidebarNavigation,
    runAfterSidebarClose: collapse,
  };
}
