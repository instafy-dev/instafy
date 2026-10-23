// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  ensure: vi.fn(),
  requestAccessToken: vi.fn(),
  cdpProps: [] as Array<{
    connectionGeneration: number;
    onTransportError: (message: string, fatal: boolean) => void;
    onDisconnected: (detail: { connected: boolean; reason: string }) => void;
    onConnected: () => void;
  }>,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: mocks.ensure, stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: { fetchHost: vi.fn(), startHost: vi.fn(), isUnavailableError: () => false, isHostRefusedError: () => false },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken } },
} }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
vi.mock("../useSharedBrowserApproval", () => ({
  useSharedBrowserApproval: () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: vi.fn() }),
}));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
vi.mock("../CdpScreencastViewer", () => ({
  CdpScreencastViewer: (props: (typeof mocks.cdpProps)[number]) => {
    mocks.cdpProps.push(props);
    return null;
  },
}));
import {
  BrowserSessionModal,
  SHARED_BROWSER_LOST_CONNECTION_COPY,
  SHARED_BROWSER_VIEWER_WAIT_COPY,
  SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS,
} from "../BrowserSessionModal";
import type { SupportedSharedBrowserViewerKind } from "../sharedBrowserViewer";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId: sessionId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle",
  lastSeenAt: null, origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };

/**
 * A viewer that fails for good never leaves the browser in "connecting" with
 * nothing on its way (dogfood, Oct 22: "Reconnecting…" for minutes): it
 * reconnects within a bound and then says so, and a browser that waits for
 * its roster to pick a viewer gives up after a while too.
 */
describe("Shared modal reconnects", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpProps.length = 0;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.ensure.mockReset();
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(viewer: SupportedSharedBrowserViewerKind) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={sessionId} presentation="docked" fillContainer
      canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind={viewer} sharedBrowserAvailableViewerKinds={[viewer]} />); });
    await advance(0);
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const latest = () => mocks.cdpProps[mocks.cdpProps.length - 1]!;
  const text = () => document.body.textContent ?? "";

  it("reconnects after a fatal viewer error, counting an error and its socket closing once, and then says so", async () => {
    await render("cdp-screencast");
    expect(mocks.cdpProps.length).toBeGreaterThan(0);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reads = mocks.fetchStatus.mock.calls.length;
      const generation = latest().connectionGeneration;
      // The input socket closed: an error, then the screencast socket closing too.
      await act(async () => {
        latest().onTransportError("Shared Browser input closed (1006).", true);
        latest().onDisconnected({ connected: false, reason: "renderer error" });
      });
      expect(text()).not.toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
      await advance(attempt * 1_000);
      // One new attempt, which reads the session again and reconnects the viewer.
      expect(mocks.fetchStatus.mock.calls.length).toBe(reads + 1);
      expect(latest().connectionGeneration).toBe(generation + 1);
    }
    await act(async () => { latest().onTransportError("Shared Browser input closed (1006).", true); });
    expect(text()).toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
    expect(document.querySelector('[data-testid="browser-session-reconnecting"]')).toBeNull();
  });

  it("bounds a lane that keeps failing right after it connects", async () => {
    await render("cdp-screencast");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // The picture connects, then its input lane fails again at once.
      await act(async () => { latest().onConnected(); });
      await act(async () => { latest().onTransportError("Shared Browser input did not become ready.", true); });
      await advance(1_000);
    }
    await act(async () => { latest().onConnected(); });
    await act(async () => { latest().onTransportError("Shared Browser input did not become ready.", true); });
    expect(text()).toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
  });

  it("gives up waiting for the roster to pick a viewer, and says so", async () => {
    // A view-only renderer is not known until the roster says who controls it.
    await render("rfb");
    expect(mocks.requestAccessToken).toHaveBeenCalled();
    await advance(SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS - 1_000);
    expect(text()).not.toContain(SHARED_BROWSER_VIEWER_WAIT_COPY);
    await advance(1_500);
    expect(text()).toContain(SHARED_BROWSER_VIEWER_WAIT_COPY);
    expect(document.querySelector('[data-testid="browser-session-error-retry"]')).not.toBeNull();
  });

  it("writes its copy without em dashes", () => {
    for (const copy of [SHARED_BROWSER_LOST_CONNECTION_COPY, SHARED_BROWSER_VIEWER_WAIT_COPY]) expect(copy).not.toMatch(/—/);
  });
});
