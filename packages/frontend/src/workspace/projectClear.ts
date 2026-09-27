import { getAppRouter } from "../navigation/appRouterBridge";
import { getStudioVisitKey } from "../navigation/studioVisit";
import { useWorkspaceStore } from "../store";

const PROJECT_URL_PARAMS = ["projectId", "conversationId", "conversationControllerId"];

/**
 * A bare history.replaceState never reaches the router, so its location would
 * keep the old space. The studio's URL writer and the chat's scroll restore
 * hold still while the router disagrees with the address bar, the project
 * bootstrap reads the router and would look the old space up again for a new
 * account, and the next navigation built from the router would bring the
 * params back. The address bar is rewritten first, so a navigation the draft
 * guard blocks still leaves it as clean as before.
 */
function removeProjectParamsFromRouter() {
  const router = getAppRouter();
  if (!router) {
    return;
  }
  const location = router.state.location;
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const key of PROJECT_URL_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  const search = params.toString();
  // A canonical replacement keeps the visit it belongs to, as the studio's
  // other URL replacements do, just as the raw write kept history.state.
  const state = location.state && typeof location.state === "object" && !Array.isArray(location.state)
    ? location.state : {};
  void router.navigate(
    { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
    { replace: true, state: { ...state, instafyVisitKey: getStudioVisitKey(location) } },
  );
}

export function clearProjectState(options?: { resetWorkspace?: boolean }) {
  try {
    if (options?.resetWorkspace ?? true) {
      useWorkspaceStore.getState().reset();
    }
  } catch {
    // ignore store reset issues
  }
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("instafy.lastProjectId");
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
      };
      runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = null;
      runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = false;
      // Strip stale projectId/conversation params from the URL so the next session
      // doesn't reuse an unauthorized project.
      try {
        const url = new URL(window.location.href);
        let changed = false;
        if (url.searchParams.has("projectId")) {
          url.searchParams.delete("projectId");
          changed = true;
        }
        if (url.searchParams.has("conversationId")) {
          url.searchParams.delete("conversationId");
          changed = true;
        }
        if (url.searchParams.has("conversationControllerId")) {
          url.searchParams.delete("conversationControllerId");
          changed = true;
        }
        if (changed) {
          const next = `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams.toString()}` : ""}${url.hash}`;
          window.history.replaceState(window.history.state, document.title, next);
        }
      } catch {
        // ignore url failures
      }
    }
  } catch {
    // ignore storage failures
  }
  try {
    removeProjectParamsFromRouter();
  } catch {
    // ignore router failures
  }
}
