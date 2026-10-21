import { HOST_MESSAGE_SOURCE, HOST_MESSAGE_VERSION, isSiteMessageSource } from "./hostMessages";
import {
  adoptLocationSite,
  isLocationStopped,
  recordLocationDelivery,
  setLocationWatching,
  subscribeLocationSites,
  type LocationSiteMeta,
} from "./locationSites";

/**
 * Studio is the only thing that calls the browser's geolocation. A site shown
 * in a preview asks Studio with `location-request`; Studio answers only the
 * frame on screen, posts to the viewer origin only, and records who got it so
 * the person can see it and stop it. The browser (or the desktop app) asks the
 * person once, for Instafy; no per-site dialogs.
 *
 * Site → Studio: `{source:<the site kit's name>, v:1,
 *   type:"location-request", payload:{id, watch?, highAccuracy?}}`, and
 *   `type:"location-stop", payload:{id}` to end a watch.
 * Studio → site: `{source:"instafy-host", v:1, type:"location", payload:{id,
 *   coords:{latitude, longitude, accuracy, altitude?, heading?, speed?}, timestamp}}`,
 *   `type:"location-error", payload:{id, code}` (which ends that request), or
 *   `type:"location-stop", payload:{id}`.
 *
 * A watch outlives a passing "unavailable" or "timeout" from the browser
 * (Chrome sends one when the position changes, phones when the signal drops):
 * only a watch that never got a position hears it, as its final error.
 */

export type LocationErrorCode = "denied" | "unavailable" | "timeout" | "stopped" | "hidden";

export type LocationRequest = { id: string; watch: boolean; highAccuracy: boolean };
export type LocationSiteMessage =
  | { type: "location-request"; request: LocationRequest }
  | { type: "location-stop"; id: string };

export type HostLocationMessage =
  | { source: typeof HOST_MESSAGE_SOURCE; v: typeof HOST_MESSAGE_VERSION; type: "location"; payload: { id: string; coords: LocationCoords; timestamp: number } }
  | { source: typeof HOST_MESSAGE_SOURCE; v: typeof HOST_MESSAGE_VERSION; type: "location-error"; payload: { id: string; code: LocationErrorCode } }
  | { source: typeof HOST_MESSAGE_SOURCE; v: typeof HOST_MESSAGE_VERSION; type: "location-stop"; payload: { id: string } };

export type LocationCoords = {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude?: number;
  heading?: number;
  speed?: number;
};

/** A short opaque id the site picks; it only comes back to that site. */
const REQUEST_ID = /^[A-Za-z0-9:._-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a site's location message (shape only; the caller checks where it came from). */
export function parseLocationMessage(data: unknown): LocationSiteMessage | null {
  if (!isRecord(data) || !isSiteMessageSource(data.source)) return null;
  if (data.v !== HOST_MESSAGE_VERSION) return null;
  if (data.type !== "location-request" && data.type !== "location-stop") return null;
  const payload = isRecord(data.payload) ? data.payload : {};
  const id = typeof payload.id === "string" && REQUEST_ID.test(payload.id) ? payload.id : null;
  if (!id) return null;
  if (data.type === "location-stop") return { type: "location-stop", id };
  return { type: "location-request", request: { id, watch: payload.watch === true, highAccuracy: payload.highAccuracy === true } };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readCoords(position: GeolocationPosition): LocationCoords | null {
  const { latitude, longitude, accuracy, altitude, heading, speed } = position.coords;
  if (!finite(latitude) || !finite(longitude)) return null;
  const coords: LocationCoords = { latitude, longitude, accuracy: finite(accuracy) ? accuracy : 0 };
  if (finite(altitude)) coords.altitude = altitude;
  if (finite(heading)) coords.heading = heading;
  if (finite(speed)) coords.speed = speed;
  return coords;
}

export function buildLocationMessage(id: string, coords: LocationCoords, timestamp: number): HostLocationMessage {
  return { source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "location", payload: { id, coords, timestamp } };
}

export function buildLocationError(id: string, code: LocationErrorCode): HostLocationMessage {
  return { source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "location-error", payload: { id, code } };
}

export function buildLocationStop(id: string): HostLocationMessage {
  return { source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "location-stop", payload: { id } };
}

/** GeolocationPositionError codes: 1 denied, 2 unavailable, 3 timeout. */
export function locationErrorCode(error: { code?: unknown } | null | undefined): LocationErrorCode {
  return error?.code === 1 ? "denied" : error?.code === 3 ? "timeout" : "unavailable";
}

export type GeolocationLike = Pick<Geolocation, "getCurrentPosition" | "watchPosition" | "clearWatch">;

/** At most this many requests from one frame per window; more get `unavailable`. */
export const LOCATION_RATE_LIMIT = { max: 5, windowMs: 10_000 } as const;
/** Watches one frame may hold at once. */
export const LOCATION_MAX_WATCHES = 3;
export const LOCATION_TIMEOUT_MS = 15_000;
/** A one-off answer may reuse a position this old. */
export const LOCATION_MAX_AGE_MS = 30_000;

export type LocationBrokerDeps = {
  /** The browser's geolocation; null where there is none. */
  geolocation: () => GeolocationLike | null;
  /** The mounted frame's window and viewer origin; null while there is no frame. */
  target: () => { window: Window; origin: string } | null;
  /** The frame is mounted and on screen. */
  visible: () => boolean;
  /** Which site this is (title, space, stable key); null when Studio cannot tell yet. */
  site: () => Promise<LocationSiteMeta | null>;
  /** A position went to this site for the first time on this device. */
  onFirstDelivery?: (site: LocationSiteMeta) => void;
  /** The browser (or the desktop app) refused location to Instafy itself; Studio says how to turn it on. */
  onDenied?: () => void;
  now?: () => number;
};

export type LocationBroker = {
  /** Handles a `message` event; true when it was a location message from this frame. */
  handleMessage: (event: Pick<MessageEvent, "data" | "origin" | "source">) => boolean;
  /** Pauses watches while hidden, resumes them when shown. */
  setVisible: (visible: boolean) => void;
  /** Ends every watch; with a code the site is told why, else it gets `location-stop`. */
  stopAll: (code?: LocationErrorCode) => void;
  /**
   * The open preview's record changed (the agent renamed it or changed its path):
   * running watches carry on under the new name, so its 📍 and Stop still reach them.
   */
  siteChanged: (site: LocationSiteMeta | null) => void;
  /**
   * Positions this frame received since it was last loaded fresh, newest
   * last (at most 50). Anything that shares what this pane shows with other
   * people must keep them out (docs/Previews.md, "Location"). They are kept as
   * long as the page may still hold them (in its URL or state), not for a
   * fixed time.
   */
  recentPositions: () => Array<{ latitude: number; longitude: number }>;
  /** The frame was loaded fresh (a new capability or reload): what it held is gone. */
  forgetPositions: () => void;
  dispose: () => void;
};

/** Delivered positions remembered for the shared-view location guard (the newest win). */
const LOCATION_RECENT_MAX = 50;

let brokerCount = 0;
const RECORD_EVERY_MS = 60_000;

/**
 * One broker per preview pane. It answers only its own frame, while that frame
 * is on screen; a watch pauses while the pane is hidden and ends on Stop
 * sharing, Stop showing, leaving the conversation and unmount.
 */
export function createLocationBroker(deps: LocationBrokerDeps): LocationBroker {
  const brokerId = `location-broker-${++brokerCount}`;
  const now = deps.now ?? (() => Date.now());
  const requestTimes: number[] = [];
  /** Watch id → whether it asked for high accuracy. */
  const watches = new Map<string, boolean>();
  /** Watch ids that have received at least one position. */
  const answered = new Set<string>();
  let nativeWatch: { id: number; highAccuracy: boolean } | null = null;
  let site: LocationSiteMeta | null = null;
  let visible = deps.visible();
  let disposed = false;
  let recordedAt: number | null = null;
  let recent: Array<{ latitude: number; longitude: number; at: number }> = [];

  const post = (message: HostLocationMessage) => {
    const target = deps.target();
    if (!target) return;
    try { target.window.postMessage(message, target.origin); } catch { /* the frame navigated away */ }
  };

  const stopped = () => Boolean(site && isLocationStopped(site.key));

  const deliver = (ids: readonly string[], position: GeolocationPosition) => {
    const coords = readCoords(position);
    if (!coords || !site) {
      for (const id of ids) post(buildLocationError(id, "unavailable"));
      return;
    }
    const timestamp = finite(position.timestamp) ? position.timestamp : now();
    for (const id of ids) post(buildLocationMessage(id, coords, timestamp));
    recent.push({ latitude: coords.latitude, longitude: coords.longitude, at: now() });
    if (recent.length > LOCATION_RECENT_MAX) recent = recent.slice(-LOCATION_RECENT_MAX);
    for (const id of ids) if (watches.has(id)) answered.add(id);
    // A watch can fire every second; the device's list needs the time to the minute.
    const at = now();
    if (recordedAt !== null && at - recordedAt < RECORD_EVERY_MS) return;
    recordedAt = at;
    const { first } = recordLocationDelivery(site, at);
    if (first) deps.onFirstDelivery?.(site);
  };

  const clearNativeWatch = () => {
    if (nativeWatch) {
      try { deps.geolocation()?.clearWatch(nativeWatch.id); } catch { /* nothing to clear */ }
      nativeWatch = null;
    }
    setLocationWatching(brokerId, null);
  };

  /** Ends every watch: with a code the site hears why, else a plain `location-stop`. */
  const endWatches = (code: LocationErrorCode | null) => {
    const ids = [...watches.keys()];
    watches.clear();
    answered.clear();
    clearNativeWatch();
    for (const id of ids) post(code ? buildLocationError(id, code) : buildLocationStop(id));
  };

  /** Runs one browser watch for all of this frame's watch ids, while shown and allowed. */
  const syncNativeWatch = () => {
    if (disposed || watches.size === 0 || !visible || !site || stopped()) {
      clearNativeWatch();
      return;
    }
    const highAccuracy = [...watches.values()].some(Boolean);
    if (nativeWatch && nativeWatch.highAccuracy === highAccuracy) return;
    clearNativeWatch();
    const geolocation = deps.geolocation();
    if (!geolocation) { endWatches("unavailable"); return; }
    const id = geolocation.watchPosition(
      position => {
        if (!nativeWatch || nativeWatch.id !== id) return;
        if (!visible) return;
        if (stopped()) { endWatches("stopped"); return; }
        deliver([...watches.keys()], position);
      },
      error => {
        if (!nativeWatch || nativeWatch.id !== id) return;
        const code = locationErrorCode(error);
        if (code === "denied") { deps.onDenied?.(); endWatches(code); return; }
        // Passing: the browser keeps this watch running. Only watches still waiting for a first position give up.
        const waiting = [...watches.keys()].filter(watchId => !answered.has(watchId));
        if (waiting.length === watches.size) { endWatches(code); return; }
        for (const watchId of waiting) { watches.delete(watchId); post(buildLocationError(watchId, code)); }
        syncNativeWatch();
      },
      { enableHighAccuracy: highAccuracy, maximumAge: 0 },
    );
    nativeWatch = { id, highAccuracy };
    setLocationWatching(brokerId, site.key);
  };

  const withinRate = () => {
    const at = now();
    while (requestTimes.length && at - requestTimes[0] >= LOCATION_RATE_LIMIT.windowMs) requestTimes.shift();
    if (requestTimes.length >= LOCATION_RATE_LIMIT.max) return false;
    requestTimes.push(at);
    return true;
  };

  const handleRequest = async (request: LocationRequest, sourceWindow: Window) => {
    const fail = (code: LocationErrorCode) => post(buildLocationError(request.id, code));
    if (!withinRate()) return fail("unavailable");
    if (!visible) return fail("hidden");
    const resolved = await deps.site().catch(() => null);
    // The frame may have changed while Studio looked the site up.
    if (disposed || deps.target()?.window !== sourceWindow) return;
    if (!resolved) return fail("unavailable");
    adoptLocationSite(resolved);
    if (site && site.key !== resolved.key) recordedAt = null;
    site = resolved;
    if (nativeWatch) setLocationWatching(brokerId, site.key);
    if (!visible) return fail("hidden");
    if (stopped()) return fail("stopped");
    const geolocation = deps.geolocation();
    if (!geolocation) return fail("unavailable");

    if (request.watch) {
      if (!watches.has(request.id) && watches.size >= LOCATION_MAX_WATCHES) return fail("unavailable");
      watches.set(request.id, request.highAccuracy);
      syncNativeWatch();
      return;
    }
    geolocation.getCurrentPosition(
      position => {
        if (disposed || deps.target()?.window !== sourceWindow) return;
        if (!visible) return fail("hidden");
        if (stopped()) return fail("stopped");
        deliver([request.id], position);
      },
      error => {
        if (disposed || deps.target()?.window !== sourceWindow) return;
        const code = locationErrorCode(error);
        if (code === "denied") deps.onDenied?.();
        fail(code);
      },
      { enableHighAccuracy: request.highAccuracy, timeout: LOCATION_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS },
    );
  };

  // "Stop sharing location", wherever the person pressed it, ends this frame's watches.
  const unsubscribe = subscribeLocationSites(() => {
    if (site && watches.size > 0 && stopped()) endWatches("stopped");
  });

  return {
    handleMessage(event) {
      const target = deps.target();
      if (disposed || !target || event.source !== target.window || event.origin !== target.origin) return false;
      const message = parseLocationMessage(event.data);
      if (!message) return false;
      if (message.type === "location-stop") {
        answered.delete(message.id);
        if (watches.delete(message.id)) syncNativeWatch();
        return true;
      }
      void handleRequest(message.request, target.window);
      return true;
    },
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      syncNativeWatch();
    },
    stopAll(code) {
      endWatches(code ?? null);
    },
    siteChanged(next) {
      if (disposed || !site || !next || next.key === site.key) return;
      adoptLocationSite(next);
      site = next;
      recordedAt = null;
      if (watches.size === 0) return;
      if (stopped()) { endWatches("stopped"); return; }
      if (nativeWatch) setLocationWatching(brokerId, site.key);
    },
    recentPositions() {
      return recent.map(({ latitude, longitude }) => ({ latitude, longitude }));
    },
    forgetPositions() {
      recent = [];
    },
    dispose() {
      if (disposed) return;
      endWatches(null);
      disposed = true;
      unsubscribe();
    },
  };
}
