import { createContext, useCallback, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { buildStudioDestinationSearch, type StudioDestination } from "./studioNavigation";

const StudioNavigationContext = createContext<(action: () => void) => void>((action) => action());
export const StudioNavigationProvider = StudioNavigationContext.Provider;

/** Shared by the browser, Electron renderer and Capacitor WebView. No second history stack. */
export function useStudioNavigation() {
  const navigate = useNavigate();
  const runNavigation = useContext(StudioNavigationContext);
  return useCallback((destination: StudioDestination) => {
    runNavigation(() => {
    // A second click may precede Router's next render. Chain from the committed
    // browser URL, never a closure holding the preceding visit's search.
    const search = buildStudioDestinationSearch(window.location.search, destination);
    if (window.location.pathname === "/studio" && window.location.search === search) return;
    // Do not carry an overlay or the previous visit's scroll key into a new destination.
    void navigate({ pathname: "/studio", search }, { state: null });
    });
  }, [navigate, runNavigation]);
}
