import type { DataRouter } from "react-router-dom";

/**
 * The app's data router, for the few callers that must move the URL from
 * outside React, such as clearing the space on sign-out. main.tsx registers it
 * at startup. Tests and non-browser code register none, and those callers then
 * keep writing window.history directly.
 */
export type AppRouter = Pick<DataRouter, "state" | "navigate">;

let appRouter: AppRouter | null = null;

export function registerAppRouter(router: AppRouter): () => void {
  appRouter = router;
  return () => {
    if (appRouter === router) {
      appRouter = null;
    }
  };
}

export function getAppRouter(): AppRouter | null {
  return appRouter;
}
