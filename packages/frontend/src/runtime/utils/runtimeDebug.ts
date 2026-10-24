import { isAutomationBrowser } from "../../services/runtimeController/logging";

export function runtimeDebugLog(message: string, data?: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const bucket =
      window.__INSTAFY_RUNTIME_DEBUG__ ??
      (window.__INSTAFY_RUNTIME_DEBUG__ = []);
    bucket.push({
      time: Date.now(),
      message,
      data
    });
    if (bucket.length > 200) {
      bucket.shift();
    }
    if (import.meta.env.DEV && !isAutomationBrowser()) {
      // eslint-disable-next-line no-console
      console.info(`[runtime-debug] ${message}`, data ?? {});
    }
  } catch (_error) {
    // ignore debugging/logging failures
  }
}

/** Set to "1" in localStorage to show technical details in the runtime and browser surfaces. */
export const RUNTIME_DEBUG_STORAGE_KEY = "instafy.runtime.debug";

/** Whether runtime debug is on in this browser (see RUNTIME_DEBUG_STORAGE_KEY). */
export function runtimeDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
