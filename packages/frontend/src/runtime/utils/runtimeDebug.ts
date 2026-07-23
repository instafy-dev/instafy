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
