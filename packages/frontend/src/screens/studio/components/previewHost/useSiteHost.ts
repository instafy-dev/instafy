import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getSitePreview } from "../../../../services/runtimeController/previews";
import { buildHostLayoutMessage, currentStudioTheme, isSiteEnvelope, parseSiteMessage } from "./hostMessages";
import { createLocationBroker, type LocationBroker } from "./locationBroker";
import { adoptLocationSite, locationSiteKey, useLocationSiteStatus, type LocationSiteMeta } from "./locationSites";
import { usePreviewFollow } from "./usePreviewFollow";
import { useFollowAccount } from "./followStore";
import { useSiteAsks, type SiteAskHost } from "./useSiteAsks";

const NO_ERROR = () => {};

/** The preview record's title, port and path: what keys a site for location. */
export type SiteRecord = { title: string; port: number; path: string };
export type SiteMessageEvent = Pick<MessageEvent, "data" | "origin" | "source">;

/**
 * The host side of one preview pane's frame, for any site: the layout message
 * (sent on each load, when Studio's theme changes, and again when a site that
 * missed it first speaks), location, what the site says it supports, and
 * follow mode (docs/Follow-Mode.md). SitePreviewPane owns the frame, the
 * capability and the checks on where a message came from; it hands every
 * other message from its own frame here. A site that never answers is just a
 * page in a frame.
 *
 * Location (docs/Previews.md, "Location"): the frame may not use the browser's
 * geolocation. A site asks with `location-request`; this pane's broker
 * answers only its own frame while it is on screen, records which site got
 * it, and the bar shows 📍 for a site that received it. Follow mode never
 * shares a view or tap holding a position this frame received since it was
 * loaded fresh.
 *
 * Ask Octo (docs/Bound-Sites.md §2a, useSiteAsks): the layout says whether
 * this person may ask (`caps.ask`), and a site's `ask` becomes their own chat
 * message through `asks.send`, answered with `ask-status`.
 */
export function useSiteHost({ frame, viewerUrl, frameKey, projectId, previewId, frameOnScreen, record, title = "", spaceName = null, asks = null, onError = NO_ERROR }: {
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
  /** The preview's title (what Octo named it): an ask's message says "via" this, never the page's own title. */
  title?: string;
  /** The space's name, for the list of sites that received the person's location. */
  spaceName?: string | null;
  /** Ask Octo from the site (docs/Bound-Sites.md §2a); null where Studio takes no asks. */
  asks?: SiteAskHost | null;
  /** A follow-mode failure the pane shows. */
  onError?: (message: string) => void;
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
  const siteAsks = useSiteAsks({ host: asks, projectId, previewId, siteTitle: record?.title ?? title, frameOnScreen, post: postToFrame });
  const askCaps = siteAsks.caps;
  const sendLayout = useCallback(() => { postToFrame(buildHostLayoutMessage(theme, askCaps)); }, [askCaps, postToFrame, theme]);
  useEffect(() => { sendLayout(); }, [sendLayout]);

  const heardFromSite = useRef(false);
  /** Loads of the frame since it was loaded fresh (frameKey or capability changed). */
  const loadsSinceFresh = useRef(0);
  /** What the site's `layout-ack` listed ("view", "tap"); cleared with each new document. */
  const [supports, setSupports] = useState<readonly string[]>([]);
  /** Counts the frame's documents: a site that navigates must be told again that it presents. */
  const [frameLoads, setFrameLoads] = useState(0);
  const onFrameLoad = useCallback(() => {
    heardFromSite.current = false;
    loadsSinceFresh.current += 1;
    setSupports([]);
    setFrameLoads(count => count + 1);
    // The site moved to another page inside the frame: that page did not ask, so this
    // frame's watches and pending answers end. The first load is left alone, since the
    // site's scripts may have asked before it fired. Positions are kept: the new page
    // may still hold them (in its URL), so a shared view must still keep them out.
    if (loadsSinceFresh.current > 1) broker.current?.stopAll();
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
  useEffect(() => {
    loadsSinceFresh.current = 0;
    return () => { broker.current?.stopAll(); broker.current?.forgetPositions(); setSupports([]); };
  }, [frameKey, viewerUrl]);
  const locationStatus = useLocationSiteStatus(siteKey);

  const selfId = useFollowAccount();
  const follow = usePreviewFollow({
    projectId,
    previewId,
    frameOnScreen,
    postToFrame,
    supportsView: supports.includes("view"),
    supportsTap: supports.includes("tap"),
    documentKey: `${viewerUrl ?? ""}:${frameKey}:${frameLoads}`,
    // The location guard: positions this frame received since it was loaded fresh.
    recentPositions: () => broker.current?.recentPositions() ?? [],
    frameElement: () => frame.current,
    selfId,
    onError,
  });
  const followSiteEvent = useRef(follow.handleSiteEvent);
  followSiteEvent.current = follow.handleSiteEvent;
  const askEvent = useRef(siteAsks);
  askEvent.current = siteAsks;

  /** One message from this pane's frame at the viewer's origin (the pane checked both). True when it was read. */
  const handleSiteMessage = useCallback((event: SiteMessageEvent): boolean => {
    if (broker.current?.handleMessage(event)) return true;
    if (!isSiteEnvelope(event.data)) return false;
    // A site whose bridge starts after the frame's load event missed the first layout message.
    if (!heardFromSite.current) { heardFromSite.current = true; sendLayout(); }
    const parsed = parseSiteMessage(event.data);
    if (parsed) {
      // Within one document what a site supports only grows.
      if (parsed.type === "layout-ack") {
        setSupports(current => parsed.supports.every(name => current.includes(name)) ? current : [...new Set([...current, ...parsed.supports])]);
      }
      if (parsed.type === "ask") { askEvent.current.handleAsk(parsed.ask); return true; }
      if (parsed.type === "ask-invalid") { askEvent.current.handleInvalid(parsed.id); return true; }
      followSiteEvent.current(parsed);
    }
    return true;
  }, [sendLayout]);

  return {
    onFrameLoad,
    handleSiteMessage,
    follow,
    /** An ask waiting for the person's confirm in Studio's own strip (the intent said `confirm: true`). */
    askConfirm: siteAsks.confirm,
    supportsView: supports.includes("view"),
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
