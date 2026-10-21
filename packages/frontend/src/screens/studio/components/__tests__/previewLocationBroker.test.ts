// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCATION_MAX_WATCHES,
  LOCATION_RATE_LIMIT,
  createLocationBroker,
  locationErrorCode,
  parseLocationMessage,
  type LocationBroker,
} from "../previewHost/locationBroker";
import {
  LOCATION_SITES_LIMIT,
  adoptLocationSite,
  listLocationSites,
  locationPreviewStatus,
  locationSiteKey,
  locationSiteStatus,
  locationSitesStorageKey,
  recordLocationDelivery,
  resetLocationSitesForTests,
  setLocationSitesAccount,
  setLocationStopped,
  type LocationSiteMeta,
} from "../previewHost/locationSites";

const ORIGIN = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--0123456789abcdef0123456789abcdef.preview.localhost";
const POSITION = {
  coords: { latitude: 59.33, longitude: 18.06, accuracy: 12, altitude: 30, heading: null, speed: Number.NaN },
  timestamp: 1_000,
} as unknown as GeolocationPosition;
const SITE: LocationSiteMeta = {
  key: locationSiteKey({ projectId: "p1", title: "Cafés", port: 4180, path: "/" }), projectId: "p1", title: "Cafés", space: "Stockholm",
};

type Watcher = { success: PositionCallback; error?: PositionErrorCallback | null; options?: PositionOptions };

function setup(options: { visible?: boolean; site?: LocationSiteMeta | null; geolocation?: boolean } = {}) {
  const frameWindow = { postMessage: vi.fn() } as unknown as Window;
  const posted = (frameWindow.postMessage as ReturnType<typeof vi.fn>);
  const watchers = new Map<number, Watcher>();
  let nextWatch = 1;
  const pendingOnce: Watcher[] = [];
  const geolocation = {
    getCurrentPosition: vi.fn((success: PositionCallback, error?: PositionErrorCallback | null, opts?: PositionOptions) => {
      pendingOnce.push({ success, error, options: opts });
    }),
    watchPosition: vi.fn((success: PositionCallback, error?: PositionErrorCallback | null, opts?: PositionOptions) => {
      watchers.set(nextWatch, { success, error, options: opts });
      return nextWatch++;
    }),
    clearWatch: vi.fn((id: number) => { watchers.delete(id); }),
  };
  const state = { visible: options.visible ?? true, frame: frameWindow as Window | null, now: 10_000 };
  const onFirstDelivery = vi.fn();
  const onDenied = vi.fn();
  const current = { site: options.site === undefined ? SITE : options.site };
  const site = vi.fn(async () => current.site);
  const broker: LocationBroker = createLocationBroker({
    geolocation: () => options.geolocation === false ? null : geolocation,
    target: () => state.frame ? { window: state.frame, origin: ORIGIN } : null,
    visible: () => state.visible,
    site,
    onFirstDelivery,
    onDenied,
    now: () => state.now,
  });
  const send = async (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
    const handled = broker.handleMessage({ data, origin: from.origin ?? ORIGIN, source: (from.source ?? frameWindow) as MessageEventSource });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    return handled;
  };
  const messages = () => posted.mock.calls.map(call => call[0] as { type: string; payload: Record<string, unknown> });
  const last = () => messages().at(-1);
  const setVisible = (visible: boolean) => { state.visible = visible; broker.setVisible(visible); };
  const watcher = () => [...watchers.values()][0];
  return { site, current, broker, geolocation, watchers, watcher, pendingOnce, posted, messages, last, send, setVisible, state, onFirstDelivery, onDenied, frameWindow };
}

const request = (id: string, payload: Record<string, unknown> = {}, source = "instafy-site") =>
  ({ source, v: 1, type: "location-request", payload: { id, ...payload } });

describe("location messages", () => {
  it("accepts any site kit name, v1, with a short opaque id", () => {
    for (const source of ["example-map", "my-site", "site-kit"]) {
      expect(parseLocationMessage(request("r-1", { watch: true, highAccuracy: true }, source)))
        .toEqual({ type: "location-request", request: { id: "r-1", watch: true, highAccuracy: true } });
    }
    expect(parseLocationMessage({ source: "example-map", v: 1, type: "location-stop", payload: { id: "r-1" } })).toEqual({ type: "location-stop", id: "r-1" });
    expect(parseLocationMessage(request("r-1", {}, "instafy-host"))).toBeNull();
    expect(parseLocationMessage({ ...request("r-1"), v: 2 })).toBeNull();
    expect(parseLocationMessage(request("has space"))).toBeNull();
    expect(parseLocationMessage(request("x".repeat(65)))).toBeNull();
    expect(parseLocationMessage({ source: "instafy-site", v: 1, type: "select", payload: { id: "a" } })).toBeNull();
  });

  it("maps the browser's error codes", () => {
    expect(locationErrorCode({ code: 1 })).toBe("denied");
    expect(locationErrorCode({ code: 2 })).toBe("unavailable");
    expect(locationErrorCode({ code: 3 })).toBe("timeout");
    expect(locationErrorCode(null)).toBe("unavailable");
  });
});

const STORAGE_KEY = locationSitesStorageKey("user-1");

describe("location broker", () => {
  let brokers: LocationBroker[] = [];
  beforeEach(() => { localStorage.clear(); setLocationSitesAccount("user-1"); resetLocationSitesForTests(); brokers = []; });
  afterEach(() => { brokers.forEach(broker => broker.dispose()); });
  const make = (options?: Parameters<typeof setup>[0]) => { const made = setup(options); brokers.push(made.broker); return made; };

  it("answers only its own frame at the viewer origin, posting to that origin", async () => {
    const t = make();
    expect(await t.send(request("a"), { origin: "https://evil.test" })).toBe(false);
    expect(await t.send(request("a"), { source: window })).toBe(false);
    expect(await t.send(request("a"), { source: { postMessage: vi.fn() } })).toBe(false);
    expect(t.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(await t.send(request("a"))).toBe(true);
    expect(t.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    t.pendingOnce[0].success(POSITION);
    expect(t.last()).toEqual({ source: "instafy-host", v: 1, type: "location",
      payload: { id: "a", coords: { latitude: 59.33, longitude: 18.06, accuracy: 12, altitude: 30 }, timestamp: 1_000 } });
    expect(t.posted.mock.calls.every(call => call[1] === ORIGIN)).toBe(true);
    // Not a location message: left for the other handlers.
    expect(await t.send({ source: "instafy-site", v: 1, type: "select", payload: {} })).toBe(false);
  });

  it("refuses a hidden frame, and an answer that arrives after the pane was hidden", async () => {
    const t = make({ visible: false });
    await t.send(request("h"));
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "h", code: "hidden" } });
    expect(t.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    // A hidden frame does not even make Studio look the site up.
    expect(t.site).not.toHaveBeenCalled();
    t.setVisible(true);
    await t.send(request("late"));
    t.setVisible(false);
    t.pendingOnce[0].success(POSITION);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "late", code: "hidden" } });
    expect(listLocationSites()).toEqual([]);
  });

  it("drops an answer for a frame that was replaced", async () => {
    const t = make();
    await t.send(request("a"));
    t.state.frame = { postMessage: vi.fn() } as unknown as Window;
    t.pendingOnce[0].success(POSITION);
    expect(t.posted).not.toHaveBeenCalled();
  });

  it("passes the browser's refusal on as denied, and says unavailable without geolocation", async () => {
    const t = make();
    await t.send(request("d"));
    t.pendingOnce[0].error?.({ code: 1 } as GeolocationPositionError);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "d", code: "denied" } });
    // Instafy itself is blocked: Studio says where to turn it on.
    expect(t.onDenied).toHaveBeenCalledTimes(1);
    await t.send(request("d2"));
    t.pendingOnce[1].error?.({ code: 2 } as GeolocationPositionError);
    expect(t.onDenied).toHaveBeenCalledTimes(1);
    const none = make({ geolocation: false });
    await none.send(request("n"));
    expect(none.last()).toMatchObject({ type: "location-error", payload: { id: "n", code: "unavailable" } });
    const unknown = make({ site: null });
    await unknown.send(request("u"));
    expect(unknown.last()).toMatchObject({ type: "location-error", payload: { id: "u", code: "unavailable" } });
  });

  it("records the site on this device and reports only its first delivery", async () => {
    const t = make();
    await t.send(request("a"));
    t.pendingOnce[0].success(POSITION);
    expect(t.onFirstDelivery).toHaveBeenCalledExactlyOnceWith(SITE);
    expect(listLocationSites()).toEqual([{ ...SITE, lastAt: 10_000, stopped: false }]);
    expect(locationSiteStatus(SITE.key)).toMatchObject({ received: true, watching: false, known: true });
    // A fresh session (Studio reloaded) still knows the site: no second toast.
    resetLocationSitesForTests();
    const again = make();
    again.state.now = 100_000;
    await again.send(request("b"));
    again.pendingOnce[0].success(POSITION);
    expect(again.onFirstDelivery).not.toHaveBeenCalled();
    expect(listLocationSites()[0].lastAt).toBe(100_000);
  });

  it("keeps a stop sticky: requests get stopped, across reloads, until Studio allows it again", async () => {
    setLocationStopped(SITE, true);
    const t = make();
    await t.send(request("s1"));
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "s1", code: "stopped" } });
    expect(t.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([expect.objectContaining({ key: SITE.key, stopped: true })]);
    resetLocationSitesForTests();
    await t.send(request("s2"));
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "s2", code: "stopped" } });
    // Nothing the site sends turns it back on; only Studio's own control does.
    await t.send({ source: "instafy-site", v: 1, type: "location-allow", payload: { id: "s3" } });
    await t.send(request("s4"));
    expect(t.last()).toMatchObject({ payload: { id: "s4", code: "stopped" } });
    setLocationStopped(SITE.key, false);
    await t.send(request("s5"));
    expect(t.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("stops at the answer when the person stops the site while the browser was asking", async () => {
    const t = make();
    await t.send(request("a"));
    setLocationStopped(SITE, true);
    t.pendingOnce[0].success(POSITION);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "a", code: "stopped" } });
  });

  it("runs one browser watch per frame, pauses it while hidden and resumes when shown", async () => {
    const t = make();
    await t.send(request("w1", { watch: true }));
    await t.send(request("w2", { watch: true, highAccuracy: true }));
    // The second asked for high accuracy: one watch, restarted with it.
    expect(t.watchers.size).toBe(1);
    expect([...t.watchers.values()][0].options).toMatchObject({ enableHighAccuracy: true });
    [...t.watchers.values()][0].success(POSITION);
    expect(t.messages().filter(message => message.type === "location").map(message => message.payload.id)).toEqual(["w1", "w2"]);
    expect(locationSiteStatus(SITE.key).watching).toBe(true);

    t.setVisible(false);
    expect(t.watchers.size).toBe(0);
    expect(locationSiteStatus(SITE.key).watching).toBe(false);
    t.setVisible(true);
    expect(t.watchers.size).toBe(1);
    expect(t.geolocation.watchPosition).toHaveBeenCalledTimes(3);

    // The site ends one, then the other.
    await t.send({ source: "instafy-site", v: 1, type: "location-stop", payload: { id: "w2" } });
    expect([...t.watchers.values()][0].options).toMatchObject({ enableHighAccuracy: false });
    await t.send({ source: "instafy-site", v: 1, type: "location-stop", payload: { id: "w1" } });
    expect(t.watchers.size).toBe(0);
  });

  it("ends watches with stopped when the person stops the site anywhere in Studio", async () => {
    const t = make();
    await t.send(request("w", { watch: true }));
    [...t.watchers.values()][0].success(POSITION);
    setLocationStopped(SITE, true);
    expect(t.watchers.size).toBe(0);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "w", code: "stopped" } });
    // Showing it again does not restart anything.
    t.setVisible(false); t.setVisible(true);
    expect(t.watchers.size).toBe(0);
  });

  it("ends watches on Stop showing / leaving (stopAll) and on unmount (dispose)", async () => {
    const t = make();
    await t.send(request("w", { watch: true }));
    t.broker.stopAll();
    expect(t.watchers.size).toBe(0);
    expect(t.last()).toMatchObject({ type: "location-stop", payload: { id: "w" } });
    await t.send(request("w2", { watch: true }));
    expect(t.watchers.size).toBe(1);
    t.broker.dispose();
    expect(t.watchers.size).toBe(0);
    expect(locationSiteStatus(SITE.key).watching).toBe(false);
    // A disposed broker answers nothing.
    expect(await t.send(request("x"))).toBe(false);
  });

  it("a refusal ends the watch", async () => {
    const t = make();
    await t.send(request("w", { watch: true }));
    t.watcher().success(POSITION);
    t.watcher().error?.({ code: 1 } as GeolocationPositionError);
    expect(t.watchers.size).toBe(0);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "w", code: "denied" } });
    expect(t.onDenied).toHaveBeenCalledTimes(1);
  });

  it("a passing 'unavailable' does not end a watch that is following the person", async () => {
    const t = make();
    await t.send(request("w", { watch: true }));
    t.watcher().success(POSITION);
    // Chrome sends this when the position changes; phones when the signal drops. The watch keeps running.
    t.watcher().error?.({ code: 2 } as GeolocationPositionError);
    t.watcher().error?.({ code: 3 } as GeolocationPositionError);
    expect(t.watchers.size).toBe(1);
    expect(t.geolocation.clearWatch).not.toHaveBeenCalled();
    expect(t.messages().some(message => message.type === "location-error")).toBe(false);
    const moved = { ...POSITION, coords: { ...POSITION.coords, latitude: 59.4 } } as GeolocationPosition;
    t.watcher().success(moved);
    expect(t.last()).toMatchObject({ type: "location", payload: { id: "w", coords: { latitude: 59.4 } } });
    expect(locationSiteStatus(SITE.key).watching).toBe(true);
  });

  it("a watch that never got a position hears 'unavailable' as its answer; one that did keeps going", async () => {
    const t = make();
    await t.send(request("old", { watch: true }));
    t.watcher().success(POSITION);
    await t.send(request("new", { watch: true }));
    t.watcher().error?.({ code: 2 } as GeolocationPositionError);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "new", code: "unavailable" } });
    expect(t.watchers.size).toBe(1);
    t.watcher().success(POSITION);
    expect(t.last()).toMatchObject({ type: "location", payload: { id: "old" } });

    const fresh = make();
    await fresh.send(request("w", { watch: true }));
    fresh.watcher().error?.({ code: 2 } as GeolocationPositionError);
    expect(fresh.watchers.size).toBe(0);
    expect(fresh.last()).toMatchObject({ type: "location-error", payload: { id: "w", code: "unavailable" } });
  });

  it("follows a renamed preview: the watch, its 📍 and Stop move to the new name", async () => {
    const before = { ...SITE, previewId: "pv-1" };
    const t = make({ site: before });
    await t.send(request("w", { watch: true }));
    t.watcher().success(POSITION);
    const renamed = { ...before, title: "Cafés near me", key: locationSiteKey({ projectId: "p1", title: "Cafés near me", port: 4180, path: "/" }) };
    adoptLocationSite(renamed);
    t.broker.siteChanged(renamed);
    expect(locationSiteStatus(renamed.key)).toMatchObject({ received: true, watching: true, known: true });
    expect(listLocationSites().map(site => site.title)).toEqual(["Cafés near me"]);
    // Stop on the new name reaches the running watch.
    setLocationStopped(renamed, true);
    expect(t.watchers.size).toBe(0);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "w", code: "stopped" } });
  });

  it("a stop sticks when the agent renames the preview or brings it back on another port", async () => {
    setLocationStopped({ ...SITE, previewId: "pv-1" }, true);
    // Same preview, new title: still stopped, and the list shows one row under the new name.
    const renamed = { ...SITE, previewId: "pv-1", title: "Coffee", key: locationSiteKey({ projectId: "p1", title: "Coffee", port: 4180, path: "/" }) };
    const t = make({ site: renamed });
    await t.send(request("a"));
    expect(t.last()).toMatchObject({ type: "location-error", payload: { id: "a", code: "stopped" } });
    expect(listLocationSites()).toEqual([expect.objectContaining({ key: renamed.key, title: "Coffee", stopped: true })]);
    // Same title on another port (a new preview after a restart): stopped too.
    const moved = { ...renamed, previewId: "pv-2", key: locationSiteKey({ projectId: "p1", title: "Coffee", port: 5000, path: "/" }) };
    const u = make({ site: moved });
    await u.send(request("b"));
    expect(u.last()).toMatchObject({ type: "location-error", payload: { id: "b", code: "stopped" } });
    expect(u.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    // Share again applies to the site it was pressed for.
    setLocationStopped(moved.key, false);
    await u.send(request("c"));
    expect(u.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it(`rate-limits requests (${LOCATION_RATE_LIMIT.max} per ${LOCATION_RATE_LIMIT.windowMs / 1000} s) and caps watches`, async () => {
    const t = make();
    for (let index = 0; index < LOCATION_RATE_LIMIT.max + 2; index += 1) await t.send(request(`r${index}`));
    expect(t.geolocation.getCurrentPosition).toHaveBeenCalledTimes(LOCATION_RATE_LIMIT.max);
    expect(t.last()).toMatchObject({ type: "location-error", payload: { code: "unavailable" } });
    t.state.now += LOCATION_RATE_LIMIT.windowMs;
    await t.send(request("later"));
    expect(t.geolocation.getCurrentPosition).toHaveBeenCalledTimes(LOCATION_RATE_LIMIT.max + 1);

    const w = make();
    for (let index = 0; index < LOCATION_MAX_WATCHES; index += 1) await w.send(request(`w${index}`, { watch: true }));
    await w.send(request("one-more", { watch: true }));
    expect(w.last()).toMatchObject({ type: "location-error", payload: { id: "one-more", code: "unavailable" } });
  });
});

describe("sites that received location", () => {
  beforeEach(() => { localStorage.clear(); setLocationSitesAccount("user-1"); resetLocationSitesForTests(); });
  afterEach(() => { setLocationSitesAccount(null); });

  it("belongs to the signed-in account: another account, or nobody, sees none of it", () => {
    recordLocationDelivery({ ...SITE, previewId: "pv-1" }, 5);
    setLocationStopped(SITE, true);
    expect(locationSiteStatus(SITE.key)).toMatchObject({ received: true, stopped: true });
    setLocationSitesAccount("user-2");
    expect(listLocationSites()).toEqual([]);
    expect(locationSiteStatus(SITE.key)).toMatchObject({ received: false, stopped: false, known: false });
    expect(locationPreviewStatus("pv-1").received).toBe(false);
    setLocationSitesAccount(null);
    expect(listLocationSites()).toEqual([]);
    setLocationSitesAccount("user-1");
    expect(listLocationSites()).toEqual([expect.objectContaining({ key: SITE.key, stopped: true })]);
  });

  it("never drops a stopped site to make room, so its stop holds", () => {
    const site = (index: number) => ({ key: `stopped-${index}`, projectId: "p1", title: `Site ${index}`, space: null });
    // Stopped before it ever got a position, so it sorts last.
    setLocationStopped(site(0), true);
    for (let index = 1; index <= LOCATION_SITES_LIMIT; index += 1) {
      recordLocationDelivery(site(index), index);
      setLocationStopped(site(index), true);
    }
    expect(listLocationSites()).toHaveLength(LOCATION_SITES_LIMIT + 1);
    resetLocationSitesForTests();
    expect(locationSiteStatus("stopped-0").stopped).toBe(true);
    // Sites that were never stopped are what the limit trims, oldest first.
    for (let index = 0; index <= LOCATION_SITES_LIMIT; index += 1) recordLocationDelivery({ ...site(index), key: `open-${index}` }, 100 + index);
    expect(listLocationSites().filter(entry => !entry.stopped)).toHaveLength(LOCATION_SITES_LIMIT);
    expect(listLocationSites().some(entry => entry.key === "open-0")).toBe(false);
    expect(listLocationSites().filter(entry => entry.stopped)).toHaveLength(LOCATION_SITES_LIMIT + 1);
  });

  it("tells a preview's tab whether its site has the person's location", () => {
    expect(locationPreviewStatus("pv-1").received).toBe(false);
    recordLocationDelivery({ ...SITE, previewId: "pv-1" }, 5);
    expect(locationPreviewStatus("pv-1")).toMatchObject({ received: true, stopped: false });
    setLocationStopped(SITE, true);
    expect(locationPreviewStatus("pv-1").stopped).toBe(true);
  });

  it("keys a site by space, title, port and path", () => {
    const base = { projectId: "p1", title: "Cafés", port: 4180, path: "/" };
    expect(locationSiteKey(base)).toBe(locationSiteKey({ ...base, title: " Cafés " }));
    expect(locationSiteKey(base)).not.toBe(locationSiteKey({ ...base, projectId: "p2" }));
    expect(locationSiteKey(base)).not.toBe(locationSiteKey({ ...base, port: 4181 }));
    expect(locationSiteKey(base)).not.toBe(locationSiteKey({ ...base, path: "/map" }));
  });

  it("survives storage that throws, keeping the list in memory", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      setLocationStopped(SITE, true);
      expect(listLocationSites()).toEqual([expect.objectContaining({ key: SITE.key, stopped: true })]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("ignores a corrupt stored list", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(listLocationSites()).toEqual([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ key: 1 }, { ...SITE, lastAt: 5, stopped: true }]));
    resetLocationSitesForTests();
    expect(listLocationSites()).toEqual([{ ...SITE, lastAt: 5, stopped: true }]);
  });
});

describe("the shared-view location guard", () => {
  it("remembers a delivered position while the page may still hold it, not for ten minutes", async () => {
    const t = setup();
    await t.send(request("a"));
    t.pendingOnce.shift()!.success(POSITION);
    await Promise.resolve();
    expect(t.broker.recentPositions()).toEqual([{ latitude: 59.33, longitude: 18.06 }]);
    // An hour on, the page can still carry ?lat=…&lng=… or keep the fix in its state.
    t.state.now += 60 * 60_000;
    expect(t.broker.recentPositions()).toEqual([{ latitude: 59.33, longitude: 18.06 }]);
    // Stopping location does not make the page forget a position it already has.
    t.broker.stopAll("stopped");
    expect(t.broker.recentPositions()).toHaveLength(1);
    // A fresh load of the frame does.
    t.broker.forgetPositions();
    expect(t.broker.recentPositions()).toEqual([]);
  });
});
