import { useWorkspaceStore } from "../store";

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
}
