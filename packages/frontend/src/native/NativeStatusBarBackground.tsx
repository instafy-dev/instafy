import { Capacitor } from "@capacitor/core";
import { createPortal } from "react-dom";

/** Keep scrolled content out of Android's transparent, edge-to-edge status area. */
export function NativeStatusBarBackground() {
  if (Capacitor.getPlatform() !== "android") return null;

  // Paint only: native safe-area padding and keyboard scroll ownership stay with
  // the page. A body portal escapes route stacking contexts, follows the canvas
  // theme, and sits above ordinary chrome (46) but below modal scrims (50+).
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="native-status-bar-background"
      className="pointer-events-none fixed inset-x-0 top-0 z-[48] h-[var(--instafy-safe-area-inset-top,0px)] bg-inherit"
    />,
    document.body,
  );
}
