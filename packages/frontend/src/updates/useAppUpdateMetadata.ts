import { useCallback, useEffect, useRef, useState } from "react";
import { DESKTOP_UPDATER_STATUS_CHANGED_EVENT } from "../desktop/updates/state";
import {
  collectAppReleaseMetadata,
  type AppReleaseMetadata,
} from "./releaseMetadata";

export function useAppUpdateMetadata(supported: boolean) {
  const [metadata, setMetadata] = useState<AppReleaseMetadata | null>(null);
  const latestRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++latestRequestIdRef.current;
    if (!supported) {
      setMetadata(null);
      return null;
    }
    const next = await collectAppReleaseMetadata().catch(() => null);
    if (requestId === latestRequestIdRef.current) {
      setMetadata(next);
    }
    return next;
  }, [supported]);

  useEffect(() => {
    if (!supported) {
      setMetadata(null);
      return;
    }

    void refresh();
    const handleDesktopUpdaterStatusChanged = () => {
      void refresh();
    };
    window.addEventListener(
      DESKTOP_UPDATER_STATUS_CHANGED_EVENT,
      handleDesktopUpdaterStatusChanged,
    );
    return () => {
      latestRequestIdRef.current += 1;
      window.removeEventListener(
        DESKTOP_UPDATER_STATUS_CHANGED_EVENT,
        handleDesktopUpdaterStatusChanged,
      );
    };
  }, [refresh, supported]);

  return {
    metadata,
    refresh,
  };
}
