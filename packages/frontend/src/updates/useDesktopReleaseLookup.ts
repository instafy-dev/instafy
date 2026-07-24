import { useCallback, useEffect, useState } from "react";
import {
  DESKTOP_APP_LATEST_URL,
  fetchDesktopReleaseManifest,
  type DesktopReleaseLookup,
  type DesktopReleaseManifestUrl,
} from "./desktopReleaseManifest";

const DESKTOP_MANIFEST_TIMEOUT_MS = 8_000;
export const DESKTOP_MANIFEST_RECHECK_MS = 60_000;
const inFlightLookups = new Map<DesktopReleaseManifestUrl, Promise<DesktopReleaseLookup>>();

function loadDesktopReleaseLookup(url: DesktopReleaseManifestUrl) {
  const existing = inFlightLookups.get(url);
  if (existing) {
    return existing;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DESKTOP_MANIFEST_TIMEOUT_MS);
  const request = fetchDesktopReleaseManifest({ signal: controller.signal, url }).finally(() => {
    window.clearTimeout(timer);
    if (inFlightLookups.get(url) === request) {
      inFlightLookups.delete(url);
    }
  });
  inFlightLookups.set(url, request);
  return request;
}

export function useDesktopReleaseLookup(options: {
  enabled?: boolean;
  manifestUrl?: DesktopReleaseManifestUrl;
} = {}) {
  const enabled = options.enabled ?? true;
  const manifestUrl = options.manifestUrl ?? DESKTOP_APP_LATEST_URL;
  const [lookup, setLookup] = useState<DesktopReleaseLookup>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLookup({ status: "loading" });
      return;
    }

    let disposed = false;
    let recheckTimer: number | null = null;

    void loadDesktopReleaseLookup(manifestUrl)
      .then((next) => {
        if (!disposed) {
          setLookup(next);
          recheckTimer = window.setTimeout(() => {
            setAttempt((current) => current + 1);
          }, DESKTOP_MANIFEST_RECHECK_MS);
        }
      });

    return () => {
      disposed = true;
      if (recheckTimer !== null) {
        window.clearTimeout(recheckTimer);
      }
    };
  }, [attempt, enabled, manifestUrl]);

  const retry = useCallback(() => {
    if (!enabled) {
      return;
    }
    setLookup({ status: "loading" });
    setAttempt((current) => current + 1);
  }, [enabled]);

  return { lookup, retry };
}
