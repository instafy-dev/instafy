import { useEffect } from "react";
import { defineInstafyFeatureModule, INSTAFY_FEATURE_MODULE_API_VERSION } from "@instafy/sdk/feature-modules";
import { subscribeStudioPerformance, type FrontendFeatureModule } from "@instafy/frontend/feature-api";
import { createPerformanceReporter } from "./client.mjs";

function StudioPerformanceBridge() {
  useEffect(() => {
    if (window.location.protocol !== "https:" || window.location.origin !== import.meta.env.VITE_STUDIO_PERFORMANCE_COLLECTOR_ORIGIN) return;
    const reporter = createPerformanceReporter({ releaseId: import.meta.env.VITE_STUDIO_PERFORMANCE_RELEASE_ID });
    const unsubscribe = subscribeStudioPerformance(reporter.record, { replay: true });
    const onHidden = () => { if (document.visibilityState === "hidden") reporter.flush(); };
    window.addEventListener("pagehide", reporter.flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", reporter.flush);
      document.removeEventListener("visibilitychange", onHidden);
      reporter.finish();
    };
  }, []);
  return null;
}

export const STUDIO_PERFORMANCE_FEATURE_MODULE: FrontendFeatureModule = defineInstafyFeatureModule({
  id: "instafy.hosted-performance",
  apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
  studioRuntimeBridges: [{ id: "instafy.hosted-performance-bridge", component: StudioPerformanceBridge }],
});
