import { useEffect, useState } from "react";

import { instafyBuildInfo, formatInstafyBuildLabel } from "../config/buildInfo";
import { desktopUpdaterBridgeAvailable, readDesktopUpdaterStatus } from "../desktop/updates/client";

// Which build am I actually running? Unanswerable from the login screen until
// now, which is exactly where it is asked -- when an update did not appear, or
// a fix is supposedly live and the surface still looks old.
//
// In the desktop shell this reports the SHELL version from the updater bridge,
// because that is the thing that updates and the thing a user can act on. On
// web it reports the frontend build, which is the only version there is.
export function AppVersionLabel(props: { className?: string }) {
  const [label, setLabel] = useState<string>(() =>
    desktopUpdaterBridgeAvailable() ? "" : formatInstafyBuildLabel(instafyBuildInfo),
  );

  useEffect(() => {
    if (!desktopUpdaterBridgeAvailable()) {
      return;
    }
    let cancelled = false;
    // Both a null result and a rejection must fall back, or the slot stays
    // empty and reads as a rendering bug rather than a degraded read.
    void readDesktopUpdaterStatus()
      .catch(() => null)
      .then((status) => {
        if (cancelled) return;
        setLabel(
          status?.currentVersion
            ? `Instafy ${status.currentVersion}`
            : formatInstafyBuildLabel(instafyBuildInfo),
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!label) {
    return null;
  }
  return (
    <span className={props.className} data-testid="app-version-label">
      {label}
    </span>
  );
}
