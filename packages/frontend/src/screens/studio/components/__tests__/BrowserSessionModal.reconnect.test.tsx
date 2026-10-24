// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  ensure: vi.fn(),
  requestAccessToken: vi.fn(),
  fetchHost: vi.fn(),
  startHost: vi.fn(),
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
  SHARED_BROWSER_RECONNECT_TIMEOUT_MS,
  SHARED_BROWSER_VIEWER_WAIT_COPY,
  SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS,
} from "../BrowserSessionModal";
import type { SupportedSharedBrowserViewerKind } from "../sharedBrowserViewer";
import { SHARED_BROWSER_HOST_COPY } from "../sharedBrowserHostAttach";
import type { SharedBrowserApprovalState } from "../useSharedBrowserApproval";

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
    expect(reconnecting()).toBe(true);
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
    expect(text()).not.toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
  });

  it("bounds a picture that closes right after each first frame, and says so", async () => {
    await render("cdp-screencast");
    await act(async () => { latest().onConnected(); });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
      expect(text()).not.toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
      await advance(1_000);
      await act(async () => { latest().onConnected(); });
    }
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    expect(text()).toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
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
    expect(text()).toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
    expect(retryShown()).toBe(true);
    await act(async () => { answer?.({ runtimes: [session] }); });
    await advance(5_000);
    expect(reconnecting()).toBe(false);
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
    expect(text()).toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
    await act(async () => { answer?.({ runtimes: [session] }); });
    await advance(1_000);
    expect(reconnecting()).toBe(false);
    expect(retryShown()).toBe(true);
  });

  it("writes its copy without em dashes", () => {
    for (const copy of [SHARED_BROWSER_LOST_CONNECTION_COPY, SHARED_BROWSER_VIEWER_WAIT_COPY]) expect(copy).not.toMatch(/—/);
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

  it("says the browser restarted when a reconnect finds it started again, and waits for Retry", async () => {
    await render();
    await act(async () => { latest().onConnected(); });
    mocks.fetchHost.mockResolvedValue(host("ready", "generation-2"));
    await act(async () => { latest().onDisconnected({ connected: true, reason: "WebSocket closed (1006)" }); });
    await advance(1_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.restarted);
    expect(text()).not.toContain(SHARED_BROWSER_LOST_CONNECTION_COPY);
    expect(retryButton()).not.toBeNull();
    // Nothing reconnects by itself to a browser whose pages are gone.
    const reads = mocks.fetchStatus.mock.calls.length;
    await advance(SHARED_BROWSER_RECONNECT_TIMEOUT_MS + 5_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(reads);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.restarted);
    // Retry opens the restarted browser.
    await act(async () => { retryButton()!.click(); });
    await advance(0);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.restarted);
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
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.restarted);
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
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.notAvailable);
    expect(document.querySelector('[data-testid="shared-browser-approval-prompt"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')!.click(); });
    expect(decide).toHaveBeenCalledWith("allow_once");
    // A lane for another machine never stands in for this view's own.
    await render({ runApproval: { runtimeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", approval } });
    expect(document.querySelector('[data-testid="shared-browser-approval-prompt"]')).toBeNull();
  });

  it("writes its copy without em dashes", () => {
    for (const copy of [SHARED_BROWSER_HOST_COPY.restarted, SHARED_BROWSER_HOST_COPY.policyOff]) expect(copy).not.toMatch(/—/);
  });
});
