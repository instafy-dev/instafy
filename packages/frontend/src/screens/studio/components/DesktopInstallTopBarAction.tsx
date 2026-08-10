import { Download } from "iconoir-react";
import { canOfferDesktopAcquisition } from "../../../updates/desktopAcquisition";
import { DESKTOP_APP_PUBLIC_LATEST_URL } from "../../../updates/desktopReleaseManifest";
import { useDesktopReleaseLookup } from "../../../updates/useDesktopReleaseLookup";
import {
  DARK_CONTROL_HOVER_CLASS,
  DARK_RAIL_HOVER_CLASS,
  DARK_RAISED_CONTROL_BG_CLASS,
} from "../../../theme/darkSurfaces";

export function DesktopInstallTopBarAction({
  enabled,
  variant = "rail",
}: {
  enabled: boolean;
  variant?: "rail" | "compact";
}) {
  const isWebSurface = canOfferDesktopAcquisition();
  const { lookup } = useDesktopReleaseLookup({
    enabled: enabled && isWebSurface,
    manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
  });

  if (!enabled || !isWebSurface || lookup.status !== "available") {
    return null;
  }

  return (
    <a
      href="/install#desktop"
      target="_blank"
      rel="noreferrer"
      aria-label="Get Instafy Desktop"
      title={`Get Instafy Desktop v${lookup.manifest.version}`}
      data-testid="topbar-get-desktop"
      data-variant={variant}
      className={[
        // Chrome, not promotion: this link wears the same muted neutral text
        // colours as the adjacent top-bar buttons (see
        // desktopTabActionButtonClassName in StudioTopBar) so it does not
        // compete with conversation content. Hover keeps the link affordance.
        "inline-flex flex-none items-center justify-center gap-2 border border-transparent text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-100/80 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:text-slate-300 dark:hover:text-slate-50",
        variant === "rail"
          ? `h-[48px] min-w-12 px-3 focus-visible:ring-inset ${DARK_RAIL_HOVER_CLASS}`
          : `h-9 rounded-full bg-slate-100 px-3 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_CONTROL_HOVER_CLASS}`,
      ].join(" ")}
    >
      <Download className="h-[18px] w-[18px]" aria-hidden="true" />
      <span className={variant === "rail" ? "hidden min-[1180px]:inline" : undefined}>
        Get Desktop
      </span>
    </a>
  );
}
