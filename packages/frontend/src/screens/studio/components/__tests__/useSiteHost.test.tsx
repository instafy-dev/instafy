// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSiteHost } from "../previewHost/useSiteHost";
import { resetLocationSitesForTests, setLocationSitesAccount } from "../previewHost/locationSites";

vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: vi.fn(),
}));

const VIEWER = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost/";
const ORIGIN = new URL(VIEWER).origin;
const POSITION = { coords: { latitude: 59.33, longitude: 18.06, accuracy: 20, altitude: null, heading: null, speed: null }, timestamp: 1 };

type Host = ReturnType<typeof useSiteHost>;

function Harness({ frameKey, onHost }: { frameKey: number; onHost: (host: Host, frame: HTMLIFrameElement | null) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useSiteHost({
    frame, viewerUrl: VIEWER, frameKey, projectId: "project-1", previewId: "preview-1", frameOnScreen: true,
    record: { title: "Site preview", port: 4173, path: "/" }, spaceName: "Trips",
  });
  onHost(host, frame.current);
  return <iframe key={frameKey} ref={frame} title="site" />;
}

describe("useSiteHost", () => {
  let root: Root;
  let container: HTMLDivElement;
  let host: Host;
  let frame: HTMLIFrameElement | null = null;
  const onHost = (next: Host, element: HTMLIFrameElement | null) => { host = next; frame = element; };
  async function render(frameKey = 0) {
    await act(async () => root.render(<Harness frameKey={frameKey} onHost={onHost} />));
    // The ref is set after the first render: render once more so the harness sees the frame.
    await act(async () => root.render(<Harness frameKey={frameKey} onHost={onHost} />));
  }
  const fromFrame = (data: unknown) => ({ data, origin: ORIGIN, source: frame!.contentWindow });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: vi.fn((success: (position: unknown) => void) => success(POSITION)),
        watchPosition: vi.fn(() => 1),
        clearWatch: vi.fn(),
      },
    });
    localStorage.clear();
    setLocationSitesAccount("user-1");
    resetLocationSitesForTests();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    Reflect.deleteProperty(navigator, "geolocation");
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("offers location on every load, and again to a site that speaks before it got the layout", async () => {
    await render();
    const posted = vi.spyOn(frame!.contentWindow!, "postMessage").mockImplementation(() => undefined);
    act(() => host.onFrameLoad());
    expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ type: "layout", caps: { location: "host" } }), ORIGIN);
    posted.mockClear();
    expect(host.handleSiteMessage(fromFrame({ source: "my-site", v: 1, type: "hello" }))).toBe(true);
    expect(posted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "layout" }), ORIGIN);
    // Once per document; nothing from Studio's own name or another version is read.
    expect(host.handleSiteMessage(fromFrame({ source: "my-site", v: 1, type: "hello" }))).toBe(true);
    expect(host.handleSiteMessage(fromFrame({ source: "instafy-host", v: 1, type: "layout" }))).toBe(false);
    expect(host.handleSiteMessage(fromFrame({ source: "my-site", v: 2, type: "hello" }))).toBe(false);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("remembers that the frame got a position until it is loaded fresh, not for a fixed time", async () => {
    vi.useFakeTimers();
    await render();
    vi.spyOn(frame!.contentWindow!, "postMessage").mockImplementation(() => undefined);
    expect(host.location.hasPositions()).toBe(false);
    await act(async () => {
      host.handleSiteMessage(fromFrame({ source: "my-site", v: 1, type: "location-request", payload: { id: "a" } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.location.hasPositions()).toBe(true);
    // An hour later the page may still hold it (in its URL or state).
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    expect(host.location.hasPositions()).toBe(true);
    // Reload: a new document, which holds nothing.
    await render(1);
    expect(host.location.hasPositions()).toBe(false);
  });
});
