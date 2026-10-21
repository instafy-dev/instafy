import { useEffect, useState, type ReactNode } from "react";
import { MenuTrigger } from "react-aria-components";
import { Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../../components/Button";
import { Text } from "../../../../components/Text";
import { StudioDialogBody, StudioDialogHeader } from "../../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../../components/aria/StudioModal";
import { StudioMenu, StudioMenuItem } from "../../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../../components/aria/StudioPopover";
import { formatRelativeTimestamp } from "../../homeFeed";
import { locationPreviewStatus, setLocationStopped, useLocationSites, type LocationSiteMeta, type LocationSiteRecord, type LocationSiteStatus } from "./locationSites";

/**
 * What the person sees about location in previews: the 📍 in the preview's
 * bar (and its tab), the one-time toast, and the list of sites that received
 * it. Generic: the same for a map, a shop or a dashboard.
 */

export const locationMarkerLabel = (title: string) => `${title} can see your location`;

/**
 * 📍 in the bar or a tab; pulses while the site follows the person. With
 * reduced motion a steady ring says the same.
 */
export function LocationMarker({ title, watching }: { title: string; watching: boolean }) {
  const label = watching ? `${locationMarkerLabel(title)}, following you` : locationMarkerLabel(title);
  return <span role="img" aria-label={label} title={label} data-testid="preview-location-marker" data-watching={watching ? "true" : undefined}
    className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center text-[13px] leading-none">
    {watching ? <span aria-hidden="true" className="absolute inset-0 rounded-full bg-secondary-500/30 motion-safe:animate-ping motion-reduce:hidden" /> : null}
    {watching ? <span aria-hidden="true" data-testid="preview-location-following"
      className="absolute inset-0 rounded-full ring-2 ring-secondary-500/80 motion-safe:hidden" /> : null}
    <span aria-hidden="true" className="relative">📍</span>
  </span>;
}

export const LOCATION_TOAST_MS = 8_000;

/** Centred just under the preview's bar, over the top of the site, wrapping instead of cutting the name off. */
const TOAST_PLACEMENT = "top-2 justify-center px-3";

/** "📍 <title> can see your location · Stop": once per site on this device, never in the way. */
export function LocationToast({ title, onStop, onDismiss }: {
  title: string;
  onStop: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, LOCATION_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);
  return <div role="status" aria-live="polite" data-testid="preview-location-toast"
    className={`pointer-events-none absolute inset-x-0 z-20 flex ${TOAST_PLACEMENT}`}>
    <div className="pointer-events-auto flex min-h-9 max-w-full items-center gap-1 rounded-2xl bg-slate-900/90 py-0.5 pl-3 pr-1 text-xs font-medium text-white shadow-lg backdrop-blur">
      <span aria-hidden="true">📍</span>
      <span className="min-w-0 line-clamp-2">{locationMarkerLabel(title)}</span>
      <span aria-hidden="true" className="text-white/60">·</span>
      <Button variant="ghost" size="sm" radius="full" data-testid="preview-location-toast-stop"
        aria-label={`Stop sharing location with ${title}`} onPress={onStop}
        className="h-8 px-2 text-xs font-semibold text-white hover:bg-white/10 pointer-coarse:h-11">Stop</Button>
      <IconButton variant="ghost" radius="full" size="xs" aria-label="Dismiss" onPress={onDismiss}
        className="text-white/80 hover:bg-white/10 pointer-coarse:h-11 pointer-coarse:w-11">
        <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
      </IconButton>
    </div>
  </div>;
}

function lastSeen(record: LocationSiteRecord, now: number): string {
  if (record.lastAt === null) return "Never received it";
  const relative = formatRelativeTimestamp(record.lastAt, now);
  return relative === "just now" ? "Last sent just now" : `Last sent ${relative} ago`;
}

/** Sites that received the person's location on this device, with Stop. */
export function LocationSitesList({ emptyText = "No site in a preview has received your location on this device." }: { emptyText?: string }) {
  const sites = useLocationSites();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (sites.length === 0) {
    return <Text variant="caption" tone="muted" data-testid="location-sites-empty">{emptyText}</Text>;
  }
  return <ul className="divide-y divide-slate-200/70 dark:divide-[color:var(--color-studio-dark-divider)]" data-testid="location-sites-list">
    {sites.map(site => (
      <li key={site.key} className="flex min-h-12 items-center gap-3 py-2" data-testid="location-site-row" data-stopped={site.stopped ? "true" : undefined}>
        <span aria-hidden="true" className={site.stopped ? "opacity-40 grayscale" : undefined}>📍</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" data-testid="location-site-title">{site.title}</div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {[site.space, site.stopped ? "Stopped" : lastSeen(site, now)].filter(Boolean).join(" · ")}
          </div>
        </div>
        {site.stopped ? (
          <Button variant="outline" size="sm" radius="lg" data-testid="location-site-allow"
            aria-label={`Share location again with ${site.title}`} onPress={() => setLocationStopped(site.key, false)}>Share again</Button>
        ) : (
          // Only Stop: a "remove from list" here would read as taking location away, and it doesn't.
          <Button variant="outline" size="sm" radius="lg" data-testid="location-site-stop"
            aria-label={`Stop sharing location with ${site.title}`} onPress={() => setLocationStopped(site.key, true)}>Stop</Button>
        )}
      </li>
    ))}
  </ul>;
}

export const LOCATION_SITES_DESCRIPTION = "Sites in previews ask Instafy for your location; the browser asks you once, for Instafy. "
  + "Each site that received it is listed here. Stop keeps that site from getting it until you share again. Kept on this device.";

export const LOCATION_BLOCKED_MS = 12_000;

export const MACOS_LOCATION_SETTINGS = "System Settings → Privacy & Security → Location Services";

/** What refused location to Instafy itself: the browser, the desktop app's own answer, or the operating system. */
export type LocationBlockedBy = "browser" | "app" | "system";

/** Where to turn location back on for Instafy itself. */
export function locationBlockedText(by: LocationBlockedBy, platform = typeof navigator === "undefined" ? "" : navigator.platform): string {
  if (by === "browser") return "Your browser blocks location for Instafy. Allow it in the browser's site settings for this page, then try again.";
  if (by === "app") return "Location is off for the Instafy app. Turn it on in Settings → Profile → Location, or with the Location Permission… menu item.";
  if (/^Mac/i.test(platform)) return `macOS blocks location for Instafy. Turn it on in ${MACOS_LOCATION_SETTINGS}, then try again.`;
  if (/^Win/i.test(platform)) return "Windows blocks location for Instafy. Turn it on in Settings → Privacy & security → Location, then try again.";
  return "Your computer blocks location for Instafy. Turn it on in its privacy or location settings, then try again.";
}

const desktopLocationStatus = () => typeof window === "undefined" ? undefined : window.instafyDesktop?.locationPermissionStatus;

/**
 * On desktop the app's own answer says which: when it is "denied" the app refused, otherwise
 * (allowed, or macOS decides) the operating system did. Null while that is being read.
 */
function useLocationBlockedBy(): LocationBlockedBy | null {
  const readStatus = desktopLocationStatus();
  const [by, setBy] = useState<LocationBlockedBy | null>(readStatus ? null : "browser");
  useEffect(() => {
    if (!readStatus) return;
    let cancelled = false;
    readStatus().then(
      result => { if (!cancelled) setBy(result.state === "denied" ? "app" : "system"); },
      () => { if (!cancelled) setBy("app"); },
    );
    return () => { cancelled = true; };
  }, [readStatus]);
  return by;
}

/** A site asked and Instafy itself is not allowed location: say where to change that (sites can't tell). */
export function LocationBlockedNotice({ onDismiss }: { onDismiss: () => void }) {
  const blockedBy = useLocationBlockedBy();
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, LOCATION_BLOCKED_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);
  return <div role="status" aria-live="polite" data-testid="preview-location-blocked"
    className={`pointer-events-none absolute inset-x-0 z-20 flex ${TOAST_PLACEMENT}`}>
    <div className="pointer-events-auto flex max-w-md items-start gap-2 rounded-2xl bg-slate-900/90 py-2 pl-3 pr-1 text-xs font-medium text-white shadow-lg backdrop-blur">
      <span aria-hidden="true">📍</span>
      <span className="min-w-0 flex-1">{blockedBy ? locationBlockedText(blockedBy) : "Location is off for Instafy."}</span>
      <IconButton variant="ghost" radius="full" size="xs" aria-label="Dismiss" onPress={onDismiss}
        className="text-white/80 hover:bg-white/10 pointer-coarse:h-11 pointer-coarse:w-11">
        <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
      </IconButton>
    </div>
  </div>;
}

/** The list in a dialog, opened from the 📍 in a preview's bar. */
export function LocationSitesDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return <StudioDialogModal isOpen={isOpen} onOpenChange={open => { if (!open) onClose(); }} isDismissable
    dialogAriaLabel="Sites that can see your location" data-testid="location-sites-dialog">
    <StudioDialogHeader title="Sites that can see your location" description={LOCATION_SITES_DESCRIPTION} onClose={onClose} closeLabel="Close" />
    <StudioDialogBody className="max-h-[60dvh] overflow-y-auto">
      <LocationSitesList />
    </StudioDialogBody>
  </StudioDialogModal>;
}

/**
 * The 📍 in a preview's bar, for a site that has received the person's
 * location (or was stopped from it): what it means, Stop or Share again, and
 * every site that has it. Nothing for a site that never asked.
 */
export function LocationBarControl({ site, status }: { site: LocationSiteMeta | null; status: LocationSiteStatus }) {
  const [listOpen, setListOpen] = useState(false);
  if (!site || !(status.received || status.known)) return null;
  const sharing = status.received && !status.stopped;
  const label = status.stopped ? `Location is off for ${site.title}` : sharing ? locationMarkerLabel(site.title) : `${site.title} had your location before`;
  return <>
    <MenuTrigger>
      <Button variant="ghost" size="sm" radius="full" aria-label={`${label}. Location options`} title={label}
        data-testid="site-preview-location" data-stopped={status.stopped ? "true" : undefined} className="max-[540px]:h-10 px-1.5">
        {sharing ? <LocationMarker title={site.title} watching={status.watching} />
          : <span aria-hidden="true" className="opacity-40 grayscale">📍</span>}
      </Button>
      <StudioPopover placement="bottom end" offset={6} className="w-64 p-1">
        <StudioMenu aria-label="Location options" onAction={key => {
          if (key === "stop") setLocationStopped(site, true);
          else if (key === "allow") setLocationStopped(site, false);
          else if (key === "sites") setListOpen(true);
        }}>
          {status.stopped
            ? <StudioMenuItem key="allow" id="allow" textValue="Share location again" data-testid="site-preview-location-allow">Share location again</StudioMenuItem>
            : <StudioMenuItem key="stop" id="stop" textValue="Stop sharing location" data-testid="site-preview-location-stop">Stop sharing location</StudioMenuItem>}
          <StudioMenuItem id="sites" textValue="Sites with your location" data-testid="site-preview-location-sites">Sites with your location…</StudioMenuItem>
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
    <LocationSitesDialog isOpen={listOpen} onClose={() => setListOpen(false)} />
  </>;
}

/**
 * A preview tab's 📍 for a site that has the person's location now, so every
 * open tab says which sites have it (the caller re-renders on
 * useLocationSitesVersion).
 */
export function previewTabLocation(previewId: string, title: string): { attention?: ReactNode; attentionLabel?: string } {
  const status = locationPreviewStatus(previewId);
  if (!status.received || status.stopped) return {};
  return {
    attention: <LocationMarker title={title} watching={status.watching} />,
    attentionLabel: status.watching ? "following your location" : "can see your location",
  };
}
