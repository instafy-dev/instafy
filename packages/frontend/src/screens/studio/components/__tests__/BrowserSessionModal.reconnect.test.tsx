// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  ensure: vi.fn(),
  requestAccessToken: vi.fn(),
  requestAccessTokenResult: vi.fn(),
  fetchHost: vi.fn(),
  startHost: vi.fn(),
  approvalParams: [] as Array<{ active: boolean; originEndpoint: string | null }>,
  cdpProps: [] as Array<{
    wsUrl: string;
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
  browserSessions: { fetchHost: mocks.fetchHost, startHost: mocks.startHost, isUnavailableError: () => false, isHostRefusedError: () => false },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken, requestAccessTokenResult: mocks.requestAccessTokenResult } },
} }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
vi.mock("../useSharedBrowserApproval", () => ({
  useSharedBrowserApproval: (params: { active: boolean; originEndpoint: string | null }) => {
    mocks.approvalParams.push(params);
    return { pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: vi.fn() };
  },
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
  SHARED_BROWSER_RECONNECT_TIMEOUT_MS,
  SHARED_BROWSER_VIEWER_WAIT_REASON,
  SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS,
} from "../BrowserSessionModal";
import type { SupportedSharedBrowserViewerKind } from "../sharedBrowserViewer";
import { SHARED_BROWSER_HOST_COPY } from "../sharedBrowserHostAttach";
import type { SharedBrowserApprovalState } from "../useSharedBrowserApproval";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId: sessionId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle",
  lastSeenAt: null, origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
/** What the screen says once a connection is lost for good. */
const LOST = SHARED_BROWSER_HOST_COPY.didNotOpen;
/** The grant refresh answers with the grant mock's token, as the controller client does. */
function grantResultFromToken() {
  mocks.requestAccessTokenResult.mockReset().mockImplementation(async (params: unknown) => {
    const token = await mocks.requestAccessToken(params);
    return token ? { ok: true, token } : { ok: false, error: { status: 0, message: "origin access request failed" } };
  });
}

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
    grantResultFromToken();
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
      expect(text()).not.toContain(LOST);
      await advance(attempt * 1_000);
      // One new attempt, which reads the session again and reconnects the viewer.
      expect(mocks.fetchStatus.mock.calls.length).toBe(reads + 1);
      expect(latest().connectionGeneration).toBe(generation + 1);
    }
    await act(async () => { latest().onTransportError("Shared Browser input closed (1006).", true); });
    expect(text()).toContain(LOST);
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
    expect(text()).toContain(LOST);
  });

  it("gives up waiting for the roster to pick a viewer, and says so", async () => {
    // A view-only renderer is not known until the roster says who controls it.
    await render("rfb");
    expect(mocks.requestAccessToken).toHaveBeenCalled();
    await advance(SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS - 1_000);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    await advance(1_500);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    expect(document.querySelector("[data-debug-reason]")?.getAttribute("data-debug-reason")).toBe(SHARED_BROWSER_VIEWER_WAIT_REASON);
    expect(document.querySelector('[data-testid="browser-session-error-retry"]')?.textContent).toBe("Try again");
  });

  const reconnecting = () => document.querySelector('[data-testid="browser-session-reconnecting"]') !== null;
  const retryShown = () => document.querySelector('[data-testid="browser-session-error-retry"]') !== null;

  it("stays connected when a reconnect's picture is back before the attempt's cached grant arrives", async () => {
    // Dogfood, Oct 24: "Reconnecting…" for 90+ s over a live picture after the
    // space's machine restarted. The new socket showed its first frame, then
    // the attempt finished with the same cached grant, so the view went back to
    // "connecting" while nothing was left to report.
    await render("cdp-screencast");
    await act(async () => { latest().onConnected(); });
    const url = latest().wsUrl;
    mocks.fetchStatus.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ runtimes: [session] }), 400)));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    // The note waits for the grace period; this picture is back before it.
    expect(reconnecting()).toBe(false);
    await advance(1_000);
    await advance(100);
    await act(async () => { latest().onConnected(); });
    expect(reconnecting()).toBe(false);
    await advance(2_000);
    expect(mocks.requestAccessToken.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(latest().wsUrl).toBe(url);
    expect(reconnecting()).toBe(false);
    await advance(120_000);
    expect(reconnecting()).toBe(false);
    expect(text()).not.toContain(LOST);
  });

  it("bounds a picture that closes right after each first frame, and says so", async () => {
    await render("cdp-screencast");
    await act(async () => { latest().onConnected(); });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
      expect(text()).not.toContain(LOST);
      await advance(1_000);
      await act(async () => { latest().onConnected(); });
    }
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    expect(text()).toContain(LOST);
    expect(retryShown()).toBe(true);
    expect(reconnecting()).toBe(false);
  });

  it("ends an automatic reconnect that hears nothing with Retry, and a late answer does not bring it back", async () => {
    await render("cdp-screencast");
    await act(async () => { latest().onConnected(); });
    let answer: ((value: unknown) => void) | null = null;
    mocks.fetchStatus.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(SHARED_BROWSER_RECONNECT_TIMEOUT_MS - 1_000);
    expect(reconnecting()).toBe(true);
    await advance(1_500);
    expect(reconnecting()).toBe(false);
    expect(text()).toContain(LOST);
    expect(retryShown()).toBe(true);
    // The abandoned attempt's answer arrives late, and would mint a new grant
    // (a new connection, not the cached one the view already has).
    const url = latest().wsUrl;
    mocks.requestAccessToken.mockResolvedValue({ token: "origin-token-2", endpoint: "https://origin.test", expiresIn: 300 });
    await act(async () => { answer?.({ runtimes: [session] }); });
    await advance(5_000);
    expect(latest().wsUrl).toBe(url);
    expect(reconnecting()).toBe(false);
    expect(text()).toContain(LOST);
    expect(retryShown()).toBe(true);
  });

  it("keeps its lost-connection error when the last attempt's grant arrives late", async () => {
    await render("cdp-screencast");
    await act(async () => { latest().onConnected(); });
    let answer: ((value: unknown) => void) | null = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (attempt === 5) mocks.fetchStatus.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      await act(async () => { latest().onTransportError("Shared Browser renderer connection failed.", true); });
      await advance(attempt * 1_000);
    }
    expect(text()).toContain(LOST);
    await act(async () => { answer?.({ runtimes: [session] }); });
    await advance(1_000);
    expect(reconnecting()).toBe(false);
    expect(retryShown()).toBe(true);
  });

});

/**
 * Instafy's browser on the space's own machine: a re-attach remembers the
 * browser it connected to (the host's `generation`, new for every start).
 */
describe("Shared modal re-attach to the space's own browser", () => {
  let root: Root;
  let container: HTMLDivElement;
  const hostId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const hostEntry = { runtimeId: hostId, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime", health: "online",
    lastSeenAt: null, isLocal: false, origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] },
    sharedBrowserHost: { version: 1, mode: "lazy" } };
  const host = (state: string, generation: string | null) => ({ version: 1, mode: "lazy", state, generation, failure: null,
    startedByYou: false, othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false });
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpProps.length = 0;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [hostEntry], preferredRuntimeId: null, sharedBrowserHostPolicy: "covered" });
    mocks.fetchHost.mockReset().mockResolvedValue(host("ready", "generation-1"));
    mocks.startHost.mockReset().mockResolvedValue(host("starting", "generation-2"));
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    grantResultFromToken();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(options: { attachRequestToken?: number; runApproval?: { runtimeId: string; approval: SharedBrowserApprovalState } | null } = {}) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} presentation="docked" fillContainer
      canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
      attachRequestToken={options.attachRequestToken ?? 0} runApproval={options.runApproval ?? null} />); });
    await advance(0);
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const latest = () => mocks.cdpProps[mocks.cdpProps.length - 1]!;
  const text = () => document.body.textContent ?? "";
  const reconnecting = () => document.querySelector('[data-testid="browser-session-reconnecting"]') !== null;
  const retryButton = () => document.querySelector<HTMLButtonElement>('[data-testid="browser-session-error-retry"]');

  it("reconnects the picture of the same browser without a new grant, keeping its connection", async () => {
    await render();
    await act(async () => { latest().onConnected(); });
    const grants = mocks.requestAccessToken.mock.calls.length;
    const url = latest().wsUrl;
    const generation = latest().connectionGeneration;
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(1_000);
    // The attempt read the host again and found the browser it had.
    expect(mocks.fetchHost).toHaveBeenCalledTimes(2);
    expect(latest().connectionGeneration).toBe(generation + 1);
    expect(latest().wsUrl).toBe(url);
    expect(mocks.requestAccessToken).toHaveBeenCalledTimes(grants);
    await act(async () => { latest().onConnected(); });
    expect(reconnecting()).toBe(false);
    expect(retryButton()).toBeNull();
  });

  it("says the browser is off when a reconnect finds it started again, and waits for a press", async () => {
    await render();
    await act(async () => { latest().onConnected(); });
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(1_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(text()).not.toContain(LOST);
    expect(retryButton()?.textContent).toBe("Open browser");
    expect(mocks.startHost).not.toHaveBeenCalled();
    // Nothing reconnects by itself to a browser whose pages are gone.
    const reads = mocks.fetchStatus.mock.calls.length;
    await advance(SHARED_BROWSER_RECONNECT_TIMEOUT_MS + 5_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(reads);
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    // A press opens the restarted browser.
    await act(async () => { retryButton()!.click(); });
    await advance(0);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.off);
    await act(async () => { latest().onConnected(); });
    expect(retryButton()).toBeNull();
    expect(reconnecting()).toBe(false);
  });

  it("stops reading and starting the browser once an automatic reconnect gives up", async () => {
    await render();
    await act(async () => { latest().onConnected(); });
    // The machine's browser answers with a 404 that is polled through.
    const notFound = Object.assign(new Error("Instafy's browser not found (404)"), { name: "SharedBrowserHostNotFoundError", status: 404, code: null });
    mocks.fetchHost.mockRejectedValue(notFound);
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    for (let elapsed = 0; elapsed < SHARED_BROWSER_RECONNECT_TIMEOUT_MS + 500; elapsed += 250) await advance(250);
    expect(text()).toContain(LOST);
    const reads = mocks.fetchHost.mock.calls.length;
    expect(reads).toBeGreaterThan(2);
    // Nobody presses Retry. The machine now says its browser is idle.
    mocks.fetchHost.mockResolvedValue(host("idle", "generation-1"));
    for (let elapsed = 0; elapsed < 10_000; elapsed += 250) await advance(250);
    expect(mocks.fetchHost).toHaveBeenCalledTimes(reads);
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(text()).toContain(LOST);
  });

  it("opens a browser that started again on a refresh after an automatic reconnect connected", async () => {
    await render();
    await act(async () => { latest().onConnected(); });
    // The picture drops and reconnects by itself to the same browser.
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(1_000);
    await act(async () => { latest().onConnected(); });
    expect(reconnecting()).toBe(false);
    // Later the browser starts again, and the person refreshes the sessions.
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    mocks.requestAccessToken.mockResolvedValue({ token: "origin-token-2", endpoint: "https://origin.test", expiresIn: 300 });
    const url = latest().wsUrl;
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.getAttribute("aria-label") === "Refresh sessions")!.click());
    await advance(0);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(latest().wsUrl).not.toBe(url);
    await act(async () => { latest().onConnected(); });
    expect(retryButton()).toBeNull();
    expect(reconnecting()).toBe(false);
  });

  it("just connects when the person's own press finds the browser started again", async () => {
    await render();
    await act(async () => { latest().onConnected(); });
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    await render({ attachRequestToken: 1 });
    await advance(0);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.off);
    await act(async () => { latest().onConnected(); });
    expect(retryButton()).toBeNull();
  });

  it("shows and answers the running job's prompt while the view itself cannot open", async () => {
    // Dogfood, Oct 24: the view said Instafy's browser was not available, so
    // its own poll stopped and the run's prompt expired unseen.
    mocks.fetchHost.mockResolvedValue(null);
    const decide = vi.fn(async () => {});
    const request = {
      version: 1 as const, approvalId: "11111111-1111-4111-8111-111111111111", kind: "action" as const,
      ownerId: "owner", runId: "22222222-2222-4222-8222-222222222222", initiatorUserId: "user-1", browserPageId: "page-of-the-job",
      operation: "click" as const, sourceOrigin: "https://app.example.test", destinationOrigin: "https://app.example.test",
      destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
      requestedAtMs: Date.now(), expiresAtMs: Date.now() + 120_000, requestFingerprint: "b".repeat(64),
      display: { label: "Open menu", destinationOrigin: null },
    };
    const approval: SharedBrowserApprovalState = { pending: { runtimeId: hostId, request }, submitting: false, error: null,
      routineApprovedRunId: null, lastDecision: null, decide };
    await render({ runApproval: { runtimeId: hostId, approval } });
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(document.querySelector('[data-testid="shared-browser-approval-prompt"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')!.click(); });
    expect(decide).toHaveBeenCalledWith("allow_once", request.approvalId);
    // A lane for another machine never stands in for this view's own.
    await render({ runApproval: { runtimeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", approval } });
    expect(document.querySelector('[data-testid="shared-browser-approval-prompt"]')).toBeNull();
  });
});

/**
 * Dogfood, Oct 24: the space's machine came back with the same runtime id
 * and a new origin. The view kept its connection to the old origin and kept
 * calling it (a grant refresh every 5 s, the collaboration socket, the
 * approval poll), while four parts of the screen said four different things.
 */
describe("Shared modal after the space's machine restarts", () => {
  let root: Root;
  let container: HTMLDivElement;
  const hostId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ensureSpaceMachine = vi.fn<() => Promise<boolean>>();
  const sockets: string[] = [];
  const hostEntry = (originId: string) => ({ runtimeId: hostId, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime",
    health: "online", lastSeenAt: null, isLocal: false,
    origin: { originId, endpoint: `https://ctl.test/origin/${originId}`, protocols: ["http"] },
    sharedBrowserHost: { version: 1, mode: "lazy" } });
  const stoppedEntry = () => ({ ...hostEntry("origin-old"), status: "stopped", health: "offline", origin: null, sharedBrowserHost: undefined });
  const covered = (...runtimes: unknown[]) => ({ runtimes, preferredRuntimeId: null, sharedBrowserHostPolicy: "covered" });
  const host = (state: string, generation: string | null) => ({ version: 1, mode: "lazy", state, generation, failure: null,
    startedByYou: false, othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false });
  const grant = (originId: string) => ({ token: `token-${originId}`, endpoint: `https://ctl.test/origin/${originId}`, expiresIn: 300 });
  const page = { id: "page-1", url: "https://example.test/", host: "example.test", label: "example", title: null, lastReferencedAt: 1, isActive: true };
  const chrome = () => ({
    pages: [page], resolved: true, pendingAction: null, error: null,
    onNavigate: vi.fn(), onBack: vi.fn(), onForward: vi.fn(), onReload: vi.fn(), onFocusPage: vi.fn(), onClearError: vi.fn(),
    controls: { navigate: true, history: true, reload: true, focusPage: true },
  });
  /** A socket to an origin that never answers: it closes shortly after. */
  class DeadSocket {
    static OPEN = 1;
    readyState = 0;
    url: string;
    private listeners: Record<string, Array<() => void>> = {};
    constructor(url: string) {
      this.url = url;
      sockets.push(url);
      setTimeout(() => { this.readyState = 3; (this.listeners.close ?? []).forEach((listener) => listener()); }, 50);
    }
    addEventListener(type: string, listener: () => void) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener() {}
    send() {}
    close() { this.readyState = 3; }
  }
  /** The grant answers per origin, the old one with `oldStatus` once the machine restarted. */
  let oldOriginStatus: number | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpProps.length = 0; mocks.approvalParams.length = 0; sockets.length = 0;
    oldOriginStatus = null;
    ensureSpaceMachine.mockReset().mockResolvedValue(true);
    mocks.fetchStatus.mockReset().mockResolvedValue(covered(hostEntry("origin-old")));
    mocks.fetchHost.mockReset().mockResolvedValue(host("ready", "generation-1"));
    mocks.startHost.mockReset().mockResolvedValue(host("starting", "generation-2"));
    mocks.requestAccessToken.mockReset().mockImplementation(async (params: { originId: string }) => grant(params.originId));
    mocks.requestAccessTokenResult.mockReset().mockImplementation(async (params: { originId: string }) =>
      params.originId === "origin-old" && oldOriginStatus !== null
        ? { ok: false, error: { status: oldOriginStatus, message: "origin is not the online origin for preferred runtime" } }
        : { ok: true, token: grant(params.originId) });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("WebSocket", DeadSocket);
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(options: { attachRequestToken?: number; autoAttachToken?: number; attachOnly?: boolean;
    resumeRuntimeId?: string | null; onViewStateChange?: (state: string | null) => void } = {}) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={options.resumeRuntimeId ?? null} presentation="docked" fillContainer
      canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
      sharedBrowserChrome={chrome()} ensureSpaceMachine={ensureSpaceMachine} conversationRuntimeId={hostId}
      attachOnly={options.attachOnly ?? false} onViewStateChange={options.onViewStateChange ?? null}
      attachRequestToken={options.attachRequestToken ?? 0} autoAttachToken={options.autoAttachToken ?? 0} />); });
    await advance(0);
  }
  async function advance(ms: number) {
    // In one-second steps, so each timer's own follow-up runs in between.
    for (let left = ms; left > 0; left -= 1_000) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(1_000, left)); });
    if (ms === 0) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  async function advanceQuietPeriod(ms: number) {
    // After asserting a terminal state, still run every due timer and promise,
    // but avoid hundreds of empty React flushes during the no-work window.
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  const latest = () => mocks.cdpProps[mocks.cdpProps.length - 1]!;
  const text = () => document.body.textContent ?? "";
  const retryButton = () => document.querySelector<HTMLButtonElement>('[data-testid="browser-session-error-retry"]');
  const refreshesTo = (originId: string) => mocks.requestAccessTokenResult.mock.calls
    .filter(([params]) => (params as { originId: string }).originId === originId).length;
  const socketsTo = (originId: string) => sockets.filter((url) => url.includes(`/origin/${originId}/`)).length;
  const approvalOn = (originId: string) => {
    const params = mocks.approvalParams[mocks.approvalParams.length - 1];
    return Boolean(params?.active && params.originEndpoint?.includes(`/origin/${originId}`));
  };
  async function connect() {
    await render();
    await act(async () => { latest().onConnected(); });
    expect(socketsTo("origin-old")).toBeGreaterThan(0);
    expect(approvalOn("origin-old")).toBe(true);
  }

  it.each([
    ["the machine has no browser any more", () => { mocks.fetchHost.mockResolvedValue(null); }, SHARED_BROWSER_HOST_COPY.off],
    ["its browser is idle", () => { mocks.fetchHost.mockResolvedValue(host("idle", null)); }, SHARED_BROWSER_HOST_COPY.off],
    ["its browser started again", () => { mocks.fetchHost.mockResolvedValue(host("ready", "generation-2")); }, SHARED_BROWSER_HOST_COPY.off],
    ["the status read fails", () => { mocks.fetchStatus.mockRejectedValue(new Error("offline")); }, SHARED_BROWSER_HOST_COPY.didNotOpen],
  ] as const)("calls nothing on the old origin once a reconnect ends in an error (%s)", async (_name, arrange, sentence) => {
    await connect();
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry("origin-new")));
    oldOriginStatus = 400;
    arrange();
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    expect(text()).toContain(sentence);
    const before = { refreshes: refreshesTo("origin-old"), sockets: socketsTo("origin-old") };
    await advanceQuietPeriod(15 * 60_000);
    expect(refreshesTo("origin-old")).toBe(before.refreshes);
    expect(socketsTo("origin-old")).toBe(before.sockets);
    expect(approvalOn("origin-old")).toBe(false);
    // An automatic reconnect never starts the browser or the machine.
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
  });

  it("calls nothing on its origin after a viewer that keeps failing gives up", async () => {
    await connect();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await act(async () => { latest().onTransportError("Shared Browser renderer connection failed.", true); });
      await advance(attempt * 1_000);
    }
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    const before = { refreshes: refreshesTo("origin-old"), sockets: socketsTo("origin-old") };
    await advanceQuietPeriod(15 * 60_000);
    expect(refreshesTo("origin-old")).toBe(before.refreshes);
    expect(socketsTo("origin-old")).toBe(before.sockets);
    expect(approvalOn("origin-old")).toBe(false);
  });

  it("stops using the old origin as soon as a reconnect reads the new one, while the browser still starts", async () => {
    await connect();
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry("origin-new")));
    // Someone else is starting the browser on the restarted machine.
    mocks.fetchHost.mockResolvedValue(host("starting", "generation-2"));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    const before = socketsTo("origin-old");
    await advance(30_000);
    expect(socketsTo("origin-old")).toBe(before);
    expect(approvalOn("origin-old")).toBe(false);
    expect(mocks.startHost).not.toHaveBeenCalled();
  });

  it("closes the collaboration socket when the browser started again on the same machine (S1)", async () => {
    // Only the browser started again: the machine and its origin stayed.
    await connect();
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    const before = { sockets: socketsTo("origin-old"), refreshes: refreshesTo("origin-old") };
    await advanceQuietPeriod(10 * 60_000);
    expect(socketsTo("origin-old")).toBe(before.sockets);
    expect(refreshesTo("origin-old")).toBe(before.refreshes);
    expect(approvalOn("origin-old")).toBe(false);
  });

  it("asks the old origin once when the machine restarts under a live picture, looks it up once, then says it is off", async () => {
    await connect();
    const reads = mocks.fetchStatus.mock.calls.length;
    // The machine came back under a new origin; its browser has not started.
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry("origin-new")));
    mocks.fetchHost.mockResolvedValue(host("idle", null));
    oldOriginStatus = 400;
    await advance(272_000);
    expect(refreshesTo("origin-old")).toBe(1);
    expect(mocks.fetchStatus.mock.calls.length).toBe(reads + 1);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(retryButton()?.textContent).toBe("Open browser");
    await advanceQuietPeriod(10 * 60_000);
    expect(refreshesTo("origin-old")).toBe(1);
    expect(refreshesTo("origin-new")).toBe(0);
    expect(mocks.fetchStatus.mock.calls.length).toBe(reads + 1);
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    // A press opens the browser on the new origin.
    mocks.fetchHost.mockResolvedValueOnce(host("idle", null)).mockResolvedValue(host("ready", "generation-2"));
    await act(async () => { retryButton()!.click(); });
    await advance(2_000);
    expect(mocks.startHost).toHaveBeenCalledTimes(1);
    expect(mocks.requestAccessToken).toHaveBeenLastCalledWith(expect.objectContaining({ originId: "origin-new" }));
    expect(latest().wsUrl).toContain("/origin/origin-new/");
  });

  it.each([
    [404, SHARED_BROWSER_HOST_COPY.off],
    [403, SHARED_BROWSER_HOST_COPY.didNotOpen],
    [401, SHARED_BROWSER_HOST_COPY.didNotOpen],
  ] as const)("stops at once, without looking the browser up again, when its grant answers %s", async (grantStatus, sentence) => {
    await connect();
    const reads = mocks.fetchStatus.mock.calls.length;
    oldOriginStatus = grantStatus;
    await advance(272_000);
    expect(refreshesTo("origin-old")).toBe(1);
    expect(text()).toContain(sentence);
    await advanceQuietPeriod(10 * 60_000);
    expect(refreshesTo("origin-old")).toBe(1);
    expect(mocks.fetchStatus.mock.calls.length).toBe(reads);
    expect(socketsTo("origin-old")).toBeGreaterThan(0);
    expect(approvalOn("origin-old")).toBe(false);
  });

  it("backs off a grant refresh that keeps failing for another reason: 5, 10, 20, 40, then 60 s", async () => {
    await connect();
    oldOriginStatus = 503;
    await advance(270_000);
    const callsAt = (refreshes: number) => refreshesTo("origin-old") === refreshes;
    expect(callsAt(1)).toBe(true);
    const gaps: number[] = [];
    let last = 0;
    for (let elapsedS = 1; elapsedS <= 240; elapsedS += 1) {
      const before = refreshesTo("origin-old");
      await advance(1_000);
      if (refreshesTo("origin-old") > before) { gaps.push(elapsedS - last); last = elapsedS; }
    }
    expect(gaps).toEqual([5, 10, 20, 40, 60, 60]);
    // It is still the live view: the picture and its connection stay.
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
  });

  it("never starts the browser for an automatic reconnect (R2)", async () => {
    await connect();
    mocks.fetchHost.mockResolvedValue(host("idle", null));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
  });

  it("never starts the machine for an automatic reconnect after the person opened the browser (S2)", async () => {
    await connect();
    mocks.fetchStatus.mockResolvedValue(covered(stoppedEntry()));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(5_000);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
  });

  it("uses a press once: a later automatic reconnect does not start the machine again (R3)", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(stoppedEntry()));
    await render({ attachOnly: true, resumeRuntimeId: hostId });
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    // The person's press starts the machine and opens its browser.
    mocks.fetchStatus.mockReset().mockResolvedValueOnce(covered(stoppedEntry())).mockResolvedValue(covered(hostEntry("origin-old")));
    await render({ attachOnly: true, resumeRuntimeId: hostId, attachRequestToken: 1 });
    await advance(1_000);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    await act(async () => { latest().onConnected(); });
    // The machine stops again; the picture drops and reconnects by itself.
    mocks.fetchStatus.mockResolvedValue(covered(stoppedEntry()));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(5_000);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    // Nor does a later attempt the person did not press for (Refresh sessions).
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.getAttribute("aria-label") === "Refresh sessions")!.click());
    await advance(5_000);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
  });

  it("uses a press once: Refresh sessions after a grant 404 turned the view off does not start the machine again", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(stoppedEntry()));
    await render({ attachOnly: true, resumeRuntimeId: hostId });
    // The person's press starts the machine and opens its browser.
    mocks.fetchStatus.mockReset().mockResolvedValueOnce(covered(stoppedEntry())).mockResolvedValue(covered(hostEntry("origin-old")));
    await render({ attachOnly: true, resumeRuntimeId: hostId, attachRequestToken: 1 });
    await advance(1_000);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    await act(async () => { latest().onConnected(); });
    // The machine stops; the next grant refresh answers 404, and the view is
    // off without an automatic reconnect.
    mocks.fetchStatus.mockResolvedValue(covered(stoppedEntry()));
    oldOriginStatus = 404;
    await advance(272_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.getAttribute("aria-label") === "Refresh sessions")!.click());
    await advance(5_000);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
  });

  it("shows one sentence, a neutral Off, an empty address and no control state when the browser is off (R4)", async () => {
    await connect();
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry("origin-new")));
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    const sentences = Array.from(document.querySelectorAll('[data-testid="browser-session-view-sentence"]')).map((node) => node.textContent);
    expect(sentences).toEqual([SHARED_BROWSER_HOST_COPY.off]);
    for (const other of [SHARED_BROWSER_HOST_COPY.didNotOpen, "Browser unavailable", "couldn't connect", "Control syncing", "did not start",
      "Technical details", "Unavailable", "Connecting to Shared Browser"]) {
      expect(text()).not.toContain(other);
    }
    expect(document.querySelector('[data-testid="browser-session-status"]')?.textContent).toBe("Off");
    // This test's narrow viewport shows the address as the phone trigger.
    const address = document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-address-trigger"]')!;
    expect(address.textContent).toBe("");
    expect(address.disabled).toBe(true);
    expect(document.querySelector('[data-testid="browser-session-error-notice"]')?.getAttribute("data-view-state")).toBe("off");
  });

  it("tells ChatPanel what it shows, so the pages are read only while it opens or is live", async () => {
    const states: Array<string | null> = [];
    await render({ onViewStateChange: (state) => states.push(state) });
    await act(async () => { latest().onConnected(); });
    mocks.fetchHost.mockResolvedValue(host("idle", null));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    expect(states.filter((state, index) => state !== states[index - 1])).toEqual(["opening", "live", "off"]);
    await act(async () => root.unmount());
    expect(states[states.length - 1]).toBeNull();
    root = createRoot(container);
  });

  it("attaches by itself while off once Studio asks, without a press and without starting the machine", async () => {
    await connect();
    mocks.fetchHost.mockResolvedValue(host("idle", null));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    // An agent started the browser again on the same machine.
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    const grants = mocks.requestAccessToken.mock.calls.length;
    await render({ autoAttachToken: 1 });
    await advance(1_000);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(mocks.requestAccessToken.mock.calls.length).toBe(grants + 1);
    await act(async () => { latest().onConnected(); });
    expect(retryButton()).toBeNull();
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(mocks.startHost).not.toHaveBeenCalled();
    // While live, the same request does nothing.
    const reads = mocks.fetchStatus.mock.calls.length;
    await render({ autoAttachToken: 2 });
    await advance(1_000);
    expect(mocks.fetchStatus.mock.calls.length).toBe(reads);
  });

  it("never starts the machine when Studio asks it to attach while the machine is stopped", async () => {
    await connect();
    mocks.fetchHost.mockResolvedValue(host("idle", null));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    mocks.fetchStatus.mockResolvedValue(covered(stoppedEntry()));
    await render({ autoAttachToken: 1 });
    await advance(5_000);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
  });

  /** The view reconnects by itself, its status read taking 3 s. */
  async function reconnectSlowly() {
    mocks.fetchStatus.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve(covered(hostEntry("origin-old"))), 3_000)));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(2_000);
    expect(document.querySelector('[data-testid="browser-session-reconnecting"]')).not.toBeNull();
  }

  it("acts on Studio's request that comes while the view reconnects by itself, once that attempt ends off", async () => {
    await connect();
    // The browser went idle, so the automatic reconnect will end off.
    mocks.fetchHost.mockResolvedValue(host("idle", null));
    mocks.startHost.mockImplementation(async () => {
      mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
      return host("starting", "generation-2");
    });
    await reconnectSlowly();
    // Studio opens the browser for an agent's card meanwhile.
    await render({ autoAttachToken: 1 });
    await advance(10_000);
    expect(mocks.startHost).toHaveBeenCalledTimes(1);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.off);
  });

  it("drops Studio's request that comes while the view reconnects by itself when that attempt connects", async () => {
    await connect();
    await reconnectSlowly();
    await render({ autoAttachToken: 1 });
    await advance(5_000);
    await act(async () => { latest().onConnected(); });
    expect(retryButton()).toBeNull();
    const reads = mocks.fetchStatus.mock.calls.length;
    await advance(10_000);
    expect(mocks.fetchStatus.mock.calls.length).toBe(reads);
    expect(mocks.startHost).not.toHaveBeenCalled();
  });
});
