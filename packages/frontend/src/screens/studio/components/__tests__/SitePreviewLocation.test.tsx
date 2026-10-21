// @vitest-environment jsdom
// Studio-brokered location in the site preview pane (docs/Previews.md, "Location").
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_PREVIEW_FRAME_ALLOW, SITE_PREVIEW_HEALTH_POLL_MS, SitePreviewPane } from "../SitePreviewPane";
import { listLocationSites, locationSiteStatus, locationSitesStorageKey, resetLocationSitesForTests, setLocationSitesAccount, setLocationStopped } from "../previewHost/locationSites";
import { previewTabLocation } from "../previewHost/PreviewLocation";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const FIRST = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost/";
const ORIGIN = new URL(FIRST).origin;
const POSITION = { coords: { latitude: 25.05, longitude: 121.53, accuracy: 20, altitude: null, heading: null, speed: null }, timestamp: 1_700_000_000_000 };

const mocks = vi.hoisted(() => ({
  createSitePreviewViewer: vi.fn(),
  getSitePreview: vi.fn(),
  heartbeatSitePreviewViewer: vi.fn(),
  revokeSitePreviewViewer: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  createSitePreviewViewer: mocks.createSitePreviewViewer,
  getSitePreview: mocks.getSitePreview,
  heartbeatSitePreviewViewer: mocks.heartbeatSitePreviewViewer,
  revokeSitePreviewViewer: mocks.revokeSitePreviewViewer,
}));

function record(title = "Site preview") {
  return { previewId: PREVIEW_ID, title, port: 4173, path: "/", runtimeId: "runtime-1",
    status: "active", health: { listening: true, status: 200 }, messageId: null, createdAt: null };
}

describe("SitePreviewPane location", () => {
  let root: Root;
  let container: HTMLDivElement;
  let geo: {
    getCurrentPosition: ReturnType<typeof vi.fn>;
    watchPosition: ReturnType<typeof vi.fn>;
    clearWatch: ReturnType<typeof vi.fn>;
    watchers: Map<number, (position: unknown) => void>;
  };
  async function render(visible = true) {
    await act(async () => root.render(<SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Site preview" visible={visible} spaceName="Trips" />));
    await flush();
  }
  async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  async function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
    await flush();
  }
  async function menu(item: "stop" | "allow" | "sites") {
    await click("[data-testid=site-preview-location]");
    await click(`[data-testid=site-preview-location-${item}]`);
  }
  const frame = () => container.querySelector<HTMLIFrameElement>("[data-testid=site-preview-frame]")!;
  async function post(data: unknown, origin = ORIGIN, source: MessageEventSource | null = frame().contentWindow) {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data, origin, source })); });
    await flush();
  }
  const request = (id: string, extra: Record<string, unknown> = {}) =>
    ({ source: "example-site", v: 1, type: "location-request", payload: { id, ...extra } });
  let sent: { mock: { calls: unknown[][] } };
  const toSite = () => sent.mock.calls.map(call => call[0] as { type?: string; payload?: Record<string, unknown>; caps?: unknown });
  const answers = () => toSite().filter(message => message.type?.startsWith("location"));
  const marker = () => container.querySelector<HTMLElement>("[data-testid=site-preview-chrome] [data-testid=preview-location-marker]");
  async function renderFramed(visible = true) {
    await render(visible);
    sent = vi.spyOn(frame().contentWindow!, "postMessage").mockImplementation(() => undefined);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.createSitePreviewViewer.mockResolvedValue({ viewerUrl: FIRST, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValue(record());
    mocks.heartbeatSitePreviewViewer.mockResolvedValue("live");
    mocks.revokeSitePreviewViewer.mockResolvedValue(undefined);
    const watchers = new Map<number, (position: unknown) => void>();
    let next = 1;
    geo = {
      watchers,
      getCurrentPosition: vi.fn((success: (position: unknown) => void) => success(POSITION)),
      watchPosition: vi.fn((success: (position: unknown) => void) => { watchers.set(next, success); return next++; }),
      clearWatch: vi.fn((id: number) => { watchers.delete(id); }),
    };
    Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
    localStorage.clear();
    setLocationSitesAccount("user-1");
    resetLocationSitesForTests();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "geolocation");
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("tells the site to ask Studio, never lets the frame use geolocation itself", async () => {
    await renderFramed();
    await act(async () => frame().dispatchEvent(new Event("load")));
    expect(toSite().find(message => message.type === "layout")).toMatchObject({ caps: { location: "host" } });
    expect(frame().getAttribute("allow")).toBe(SITE_PREVIEW_FRAME_ALLOW);
    expect(frame().getAttribute("allow")).not.toContain("geolocation");
    expect(frame().getAttribute("src")).toContain("instafy_host=studio");
  });

  it("answers the frame on screen through Studio, then shows 📍 in the bar and a one-time toast", async () => {
    await renderFramed();
    expect(marker()).toBeNull();
    await post(request("a1", { highAccuracy: true }));
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(geo.getCurrentPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true });
    expect(answers()).toEqual([{ source: "instafy-host", v: 1, type: "location",
      payload: { id: "a1", coords: { latitude: 25.05, longitude: 121.53, accuracy: 20 }, timestamp: 1_700_000_000_000 } }]);
    expect(sent.mock.calls.every(call => call[1] === ORIGIN)).toBe(true);
    expect(marker()?.getAttribute("aria-label")).toBe("Site preview can see your location");
    expect(container.querySelector("[data-testid=preview-location-toast]")?.textContent).toContain("📍Site preview can see your location·Stop");
    expect(listLocationSites()).toEqual([expect.objectContaining({ title: "Site preview", space: "Trips", stopped: false })]);
    // The tab says it too.
    expect(previewTabLocation(PREVIEW_ID, "Site preview").attentionLabel).toBe("can see your location");
    // The toast goes by itself and does not come back for this site.
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(container.querySelector("[data-testid=preview-location-toast]")).toBeNull();
    await post(request("a2"));
    expect(container.querySelector("[data-testid=preview-location-toast]")).toBeNull();
    expect(marker()).not.toBeNull();
  });

  it("never answers another frame, another origin, or a hidden pane", async () => {
    await renderFramed();
    await post(request("x"), "https://evil.test");
    await post(request("x"), ORIGIN, window);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    await render(false);
    // Hidden: the frame stays mounted but gets no position.
    await post(request("h1"));
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(answers()).toEqual([expect.objectContaining({ type: "location-error", payload: { id: "h1", code: "hidden" } })]);
    expect(marker()).toBeNull();
  });

  it("pulses while following, pauses while hidden and ends when the pane goes", async () => {
    await renderFramed();
    await post(request("w1", { watch: true }));
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    await act(async () => { [...geo.watchers.values()][0](POSITION); });
    expect(answers().at(-1)).toMatchObject({ type: "location", payload: { id: "w1" } });
    expect(marker()?.dataset.watching).toBe("true");
    await render(false);
    expect(geo.watchers.size).toBe(0);
    await render(true);
    expect(geo.watchPosition).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(geo.watchers.size).toBe(0);
  });

  it("ends the watch and drops pending answers when the site moves to another page in the frame", async () => {
    await renderFramed();
    // The first load is the page that asked; it keeps its watch.
    await post(request("w1", { watch: true }));
    await act(async () => frame().dispatchEvent(new Event("load")));
    expect(geo.watchers.size).toBe(1);
    await act(async () => { [...geo.watchers.values()][0](POSITION); });
    expect(marker()?.dataset.watching).toBe("true");
    let pending: ((position: unknown) => void) | null = null;
    geo.getCurrentPosition.mockImplementation((success: (position: unknown) => void) => { pending = success; });
    await post(request("a1"));
    expect(pending).not.toBeNull();
    // A link or full-page navigation inside the same frame: same window, new document.
    await act(async () => frame().dispatchEvent(new Event("load")));
    await flush();
    expect(geo.clearWatch).toHaveBeenCalledTimes(1);
    expect(geo.watchers.size).toBe(0);
    expect(marker()?.dataset.watching).not.toBe("true");
    const before = answers().length;
    await act(async () => { pending!(POSITION); });
    expect(answers().slice(before).filter(message => message.type === "location")).toEqual([]);
    // The new page can still ask for itself.
    geo.getCurrentPosition.mockImplementation((success: (position: unknown) => void) => success(POSITION));
    await post(request("b1"));
    expect(answers().at(-1)).toMatchObject({ type: "location", payload: { id: "b1" } });
  });

  it("Stop sharing location sticks for the site until Share location again", async () => {
    await renderFramed();
    await post(request("w1", { watch: true }));
    await act(async () => { [...geo.watchers.values()][0](POSITION); });
    await click("[data-testid=site-preview-location]");
    expect([...document.querySelectorAll("[role=menuitem]")].map(item => item.textContent)).toEqual(["Stop sharing location", "Sites with your location…"]);
    await click("[data-testid=site-preview-location-stop]");
    expect(answers().at(-1)).toMatchObject({ type: "location-error", payload: { id: "w1", code: "stopped" } });
    expect(geo.watchers.size).toBe(0);
    expect(marker()).toBeNull();
    expect(container.querySelector("[data-testid=site-preview-location]")?.getAttribute("data-stopped")).toBe("true");
    // The site cannot undo it, and it survives a reload of Studio.
    await post(request("a1"));
    expect(answers().at(-1)).toMatchObject({ type: "location-error", payload: { id: "a1", code: "stopped" } });
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(localStorage.getItem(locationSitesStorageKey("user-1"))).toContain("\"stopped\":true");
    resetLocationSitesForTests();
    await post(request("a2"));
    expect(answers().at(-1)).toMatchObject({ type: "location-error", payload: { id: "a2", code: "stopped" } });
    await menu("allow");
    await post(request("a3"));
    expect(answers().at(-1)).toMatchObject({ type: "location", payload: { id: "a3" } });
  });

  it("opens the list of sites with your location from the 📍", async () => {
    await renderFramed();
    expect(container.querySelector("[data-testid=site-preview-location]")).toBeNull();
    await post(request("a1"));
    await menu("sites");
    expect(document.querySelector("[data-testid=location-sites-dialog]")?.textContent).toContain("Sites that can see your location");
    expect([...document.querySelectorAll("[data-testid=location-site-row]")].map(row => row.textContent))
      .toEqual([expect.stringContaining("Site previewTrips · Last sent")]);
  });

  it("the toast's Stop stops the site", async () => {
    await renderFramed();
    await post(request("a1"));
    await click("[data-testid=preview-location-toast-stop]");
    expect(listLocationSites()[0]?.stopped).toBe(true);
    expect(container.querySelector("[data-testid=preview-location-toast]")).toBeNull();
  });

  it("drops the toast when the pane is hidden, so it is not shown again on return", async () => {
    await renderFramed();
    await post(request("a1"));
    expect(container.querySelector("[data-testid=preview-location-toast]")).not.toBeNull();
    await render(false);
    await render(true);
    expect(container.querySelector("[data-testid=preview-location-toast]")).toBeNull();
    expect(marker()).not.toBeNull();
  });

  it("keeps the 📍 and Stop on a running watch when the agent renames the preview", async () => {
    await renderFramed();
    await post(request("w1", { watch: true }));
    await act(async () => { [...geo.watchers.values()][0](POSITION); });
    mocks.getSitePreview.mockResolvedValue(record("Site preview, renamed"));
    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_PREVIEW_HEALTH_POLL_MS); });
    await flush();
    expect(locationSiteStatus(JSON.stringify(["project-1", "Site preview, renamed", 4173, "/"]))).toMatchObject({ received: true, watching: true });
    expect(listLocationSites().map(site => site.title)).toEqual(["Site preview, renamed"]);
    await menu("stop");
    expect(answers().at(-1)).toMatchObject({ type: "location-error", payload: { id: "w1", code: "stopped" } });
    expect(geo.watchers.size).toBe(0);
  });

  it("says where to turn location on when Instafy itself is blocked", async () => {
    geo.getCurrentPosition.mockImplementation((_success: unknown, error: (value: unknown) => void) => error({ code: 1 }));
    await renderFramed();
    await post(request("a1"));
    expect(answers()).toEqual([expect.objectContaining({ type: "location-error", payload: { id: "a1", code: "denied" } })]);
    expect(container.querySelector("[data-testid=preview-location-blocked]")?.textContent).toContain("site settings");
    expect(marker()).toBeNull();
  });

  it("keys a stop by space, title, port and path, so a reopened preview stays stopped", async () => {
    setLocationStopped({ key: JSON.stringify(["project-1", "Site preview", 4173, "/"]), projectId: "project-1", title: "Site preview", space: null }, true);
    await renderFramed();
    await post(request("a1"));
    expect(answers()).toEqual([expect.objectContaining({ type: "location-error", payload: { id: "a1", code: "stopped" } })]);
    await click("[data-testid=site-preview-location]");
    expect([...document.querySelectorAll("[role=menuitem]")].map(item => item.textContent)).toContain("Share location again");
  });
});
