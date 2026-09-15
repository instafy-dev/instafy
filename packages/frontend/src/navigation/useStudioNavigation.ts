import { createContext, useCallback, useContext, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildStudioDestinationSearch, type StudioDestination, type StudioNavigationOptions } from "./studioNavigation";
import { getStudioVisitKey } from "./studioVisit";

const StudioNavigationContext = createContext<(action: () => void) => void>((action) => action());
export const StudioNavigationProvider = StudioNavigationContext.Provider;

/** Shared by the browser, Electron renderer and Capacitor WebView. No second history stack. */
export function useStudioNavigation(beforeNavigation?: (action: () => void) => void) {
  const navigate = useNavigate();
  const location = useLocation();
  const visitKey = getStudioVisitKey(location);
  const renderedEntry = useRef({ key: location.key, index: window.history.state?.idx });
  renderedEntry.current = { key: location.key, index: window.history.state?.idx };
  const contextNavigation = useContext(StudioNavigationContext);
  // StudioLayout owns the drawer and supplies its continuation directly;
  // descendants use the same continuation through the provider.
  const runNavigation = beforeNavigation ?? contextNavigation;
  return useCallback((destination: StudioDestination, options?: StudioNavigationOptions) => {
    const ownsReplacement = () => {
      const entry = window.history.state;
      return (entry?.key ?? "default") === renderedEntry.current.key && entry?.idx === renderedEntry.current.index
        && Number.isSafeInteger(entry?.idx) && entry.idx >= 0
        && getStudioVisitKey({ key: entry?.key ?? "default", state: entry?.usr }) === visitKey;
    };
    // Reject stale replacements before the continuation can close restored search.
    if (options?.replace && !ownsReplacement()) return;
    runNavigation(() => {
      if (options?.replace) {
        // Replacement owns the initiating destination. A delayed click must not
        // overwrite a source reached by Back. Closing a drawer retains the same
        // canonical visit while publishing a new rendered Router entry.
        if (!ownsReplacement()) return;
      }
      // A second click may precede Router's next render. Chain from the committed
      // browser URL, never a closure holding the preceding visit's search.
      const search = buildStudioDestinationSearch(window.location.search, destination);
      if (!options?.forceNewVisit && window.location.pathname === "/studio" && window.location.search === search) return;
      // Do not carry an overlay or the previous visit's scroll key into a new destination.
      void navigate({ pathname: "/studio", search }, {
        replace: options?.replace,
        state: options?.searchOriginToken ? { instafySearchOriginToken: options.searchOriginToken } : null,
      });
    });
  }, [navigate, runNavigation, visitKey]);
}
