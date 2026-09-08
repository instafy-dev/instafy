import { studioPerformance } from "./studioPerformance";

interface NavigationSource {
  state: { location: { pathname: string } };
  subscribe: (listener: (state: { location: { pathname: string } }) => void) => () => void;
}

/** Start before the lazy Studio route downloads; document startup includes initial JS delivery. */
export function installStudioPerformanceNavigation(router: NavigationSource) {
  const isStudio = (pathname: string) => /^\/studio\/?$/i.test(pathname);
  let inStudio = isStudio(router.state.location.pathname);
  if (inStudio) studioPerformance.begin("studio_startup", {}, 0);
  const unsubscribe = router.subscribe((state) => {
    const next = isStudio(state.location.pathname);
    if (next && !inStudio) studioPerformance.begin("studio_startup");
    if (!next && inStudio) studioPerformance.cancel();
    inStudio = next;
  });
  const onVisibility = () => {
    if (document.visibilityState === "hidden") studioPerformance.cancel("hidden");
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    studioPerformance.clear();
  };
}
