import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getSitePreview } from "../../../../services/runtimeController/previews";
import { buildHostLayoutMessage, currentStudioTheme, isSiteEnvelope } from "./hostMessages";
import { createLocationBroker, type LocationBroker } from "./locationBroker";
import { adoptLocationSite, locationSiteKey, useLocationSiteStatus, type LocationSiteMeta } from "./locationSites";

/** The preview record's title, port and path: what keys a site for location. */
export type SiteRecord = { title: string; port: number; path: string };
export type SiteMessageEvent = Pick<MessageEvent, "data" | "origin" | "source">;

/**
 * The host side of one preview pane's frame, for any site: the layout message
 * (sent on each load, when Studio's theme changes, and again when a site that
 * missed it first speaks) and location. SitePreviewPane owns the frame, the
 * capability and the checks on where a message came from; it hands every
 * other message from its own frame here. A site that never answers is just a
 * page in a frame.
 *
 * Location (docs/Previews.md, "Location"): the frame may not use the browser's
 * geolocation. A site asks with `location-request`; this pane's broker
 * answers only its own frame while it is on screen, records which site got
 * it, and the bar shows 📍 for a site that received it.
 */
export function useSiteHost({ frame, viewerUrl, frameKey, projectId, previewId, frameOnScreen, record, spaceName = null }: {
  frame: RefObject<HTMLIFrameElement | null>;
  /** The live capability address: messages go to its origin only. */
  viewerUrl: string | null;
  /** Changes when the pane reloads the frame. */
  frameKey: number;
  projectId: string;
  previewId: string;
  /** The frame is mounted, the session ready and the pane on screen. */
  frameOnScreen: boolean;
  /** From the pane's last health check; the broker fetches it itself when a site asks first. */
  record: SiteRecord | null;
  /** The space's name, for the list of sites that received the person's location. */
  spaceName?: string | null;
}) {
  const postToFrame = useCallback((message: unknown) => {
    const target = frame.current?.contentWindow;
    if (!target || !viewerUrl) return false;
    try { target.postMessage(message, new URL(viewerUrl).origin); return true; } catch { return false; }
  }, [frame, viewerUrl]);

  const [theme, setTheme] = useState(currentStudioTheme);
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => setTheme(currentStudioTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  const sendLayout = useCallback(() => { postToFrame(buildHostLayoutMessage({ theme, location: true })); }, [postToFrame, theme]);
  useEffect(() => { sendLayout(); }, [sendLayout]);

  const heardFromSite = useRef(false);
  const onFrameLoad = useCallback(() => {
    heardFromSite.current = false;
    sendLayout();
  }, [sendLayout]);

  // Location: one broker per pane, answering only this frame while it is on screen.
  const [locationToast, setLocationToast] = useState(false);
  /** A site asked and Instafy itself may not use location: Studio says where to turn it on. */
  const [locationBlocked, setLocationBlocked] = useState(false);
  const [fetchedRecord, setFetchedRecord] = useState<SiteRecord | null>(null);
  const siteRecord = record ?? fetchedRecord;
  const siteKey = siteRecord ? locationSiteKey({ projectId, ...siteRecord }) : null;
  const locationSite: LocationSiteMeta | null = useMemo(
    () => siteKey && siteRecord ? { key: siteKey, projectId, title: siteRecord.title, space: spaceName, previewId } : null,
    // The record's fields, not its identity: a health check returns a new object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewId, projectId, siteKey, siteRecord?.title, spaceName],
  );
  const locationSiteRef = useRef(locationSite);
  locationSiteRef.current = locationSite;
  const spaceNameRef = useRef(spaceName);
  spaceNameRef.current = spaceName;
  const frameOnScreenRef = useRef(frameOnScreen);
  frameOnScreenRef.current = frameOnScreen;
  const viewerUrlRef = useRef(viewerUrl);
  viewerUrlRef.current = viewerUrl;
  const broker = useRef<LocationBroker | null>(null);
  useEffect(() => {
    let alive = true;
    const created = createLocationBroker({
      geolocation: () => typeof navigator !== "undefined" && navigator.geolocation ? navigator.geolocation : null,
      target: () => {
        const target = frame.current?.contentWindow;
        const url = viewerUrlRef.current;
        if (!target || !url) return null;
        try { return { window: target, origin: new URL(url).origin }; } catch { return null; }
      },
      visible: () => frameOnScreenRef.current,
      site: async () => {
        if (locationSiteRef.current) return locationSiteRef.current;
        // A site that asks before the pane's first health check: read the record once.
        const preview = await getSitePreview(projectId, previewId);
        if (!alive) return null;
        const next = { title: preview.title, port: preview.port, path: preview.path };
        setFetchedRecord(next);
        return { key: locationSiteKey({ projectId, ...next }), projectId, title: next.title, space: spaceNameRef.current, previewId };
      },
      onFirstDelivery: () => { if (alive) setLocationToast(true); },
      onDenied: () => { if (alive) setLocationBlocked(true); },
    });
    broker.current = created;
    return () => { alive = false; created.dispose(); if (broker.current === created) broker.current = null; };
  }, [frame, previewId, projectId]);
  useEffect(() => {
    broker.current?.setVisible(frameOnScreen);
    // The one-time toast is for the moment it happens, not for when the person comes back.
    if (!frameOnScreen) { setLocationToast(false); setLocationBlocked(false); }
  }, [frameOnScreen]);
  // The agent renamed the preview or changed its path: same site, so its record, stop, 📍 and running watches follow it.
  useEffect(() => {
    if (!locationSite) return;
    adoptLocationSite(locationSite);
    broker.current?.siteChanged(locationSite);
  }, [locationSite]);
  // A new document in the frame (Reload, a new capability) did not ask: its watches end, and what it held is gone.
  useEffect(() => () => { broker.current?.stopAll(); broker.current?.forgetPositions(); }, [frameKey, viewerUrl]);
  const locationStatus = useLocationSiteStatus(siteKey);

  /** One message from this pane's frame at the viewer's origin (the pane checked both). True when it was read. */
  const handleSiteMessage = useCallback((event: SiteMessageEvent): boolean => {
    if (broker.current?.handleMessage(event)) return true;
    if (!isSiteEnvelope(event.data)) return false;
    // A site whose bridge starts after the frame's load event missed the first layout message.
    if (!heardFromSite.current) { heardFromSite.current = true; sendLayout(); }
    return true;
  }, [sendLayout]);

  return {
    onFrameLoad,
    handleSiteMessage,
    location: {
      site: locationSite,
      status: locationStatus,
      toast: locationToast && Boolean(locationSite) && !locationStatus.stopped,
      dismissToast: () => setLocationToast(false),
      blocked: locationBlocked,
      dismissBlocked: () => setLocationBlocked(false),
      /**
       * Positions this frame received since it was loaded fresh. Anything that
       * shares what this pane shows with other people must keep
       * them out while this is true.
       */
      hasPositions: () => (broker.current?.recentPositions().length ?? 0) > 0,
    },
  };
}
