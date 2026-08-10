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
        // isEnabled is false for an unpackaged shell, where app.getVersion()
        // returns ELECTRON's version rather than the app's -- it rendered
        // "Instafy 43.1.1" in a dev run, which is exactly the wrong answer to
        // "which build am I on" in the situation where you most need it.
        // Packaged builds read the real version from Info.plist.
        setLabel(
          status?.isEnabled && status.currentVersion
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
