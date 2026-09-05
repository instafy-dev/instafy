import { useEffect } from "react";
import { markNativeOtaAppMounted } from "./appReady";

/** Mount inside the successful router shell, never its error or hydration fallback. */
export function NativeOtaAppReady() {
  useEffect(() => {
    // Allow immediate commit error recovery/unmount to cancel the acknowledgment.
    const timer = window.setTimeout(markNativeOtaAppMounted, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
