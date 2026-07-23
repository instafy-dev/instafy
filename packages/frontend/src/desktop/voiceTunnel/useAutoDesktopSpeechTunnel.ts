import { useEffect, useRef } from "react";
import { desktopSpeechTunnelBridgeAvailable } from "./client";
import { syncDesktopSpeechRouteForProject, type ManagedDesktopSpeechRoute } from "./sync";

const AUTO_DESKTOP_SPEECH_TUNNEL_REFRESH_MS = 30_000;

export function useAutoDesktopSpeechTunnel(input: {
  enabled: boolean;
  projectId: string | null | undefined;
  controllerUrl: string | null | undefined;
}) {
  const managedRouteRef = useRef<ManagedDesktopSpeechRoute | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!input.enabled || !desktopSpeechTunnelBridgeAvailable()) {
      return;
    }

    let cancelled = false;
    const runSync = async () => {
      if (inFlightRef.current) {
        return await inFlightRef.current;
      }
      const currentManagedRoute = managedRouteRef.current;
      const syncPromise = syncDesktopSpeechRouteForProject({
        projectId: input.projectId,
        controllerUrl: input.controllerUrl,
        previousManagedRoute: currentManagedRoute,
      })
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (result.status === "synced") {
            managedRouteRef.current = result.managedRoute;
          }
        })
        .finally(() => {
          if (inFlightRef.current === syncPromise) {
            inFlightRef.current = null;
          }
        });
      inFlightRef.current = syncPromise;
      return await syncPromise;
    };

    void runSync();
    const intervalId = window.setInterval(() => {
      void runSync();
    }, AUTO_DESKTOP_SPEECH_TUNNEL_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [input.controllerUrl, input.enabled, input.projectId]);
}
