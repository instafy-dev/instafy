// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  ensure: vi.fn(),
  requestAccessToken: vi.fn(),
  cdpProps: [] as Array<{ onConnected: () => void }>,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: mocks.ensure, stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: { fetchHost: vi.fn(), startHost: vi.fn(), isUnavailableError: () => false, isHostRefusedError: () => false },
  workspace: { origin: {
    requestAccessToken: mocks.requestAccessToken,
    requestAccessTokenResult: async (params: unknown) => ({ ok: true, token: await mocks.requestAccessToken(params) }),
  } },
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
import { BrowserSessionModal } from "../BrowserSessionModal";
import { SHARED_BROWSER_HOST_COPY } from "../sharedBrowserHostAttach";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * Live test, Oct 27: after a browser turn the space's browser session machine
 * stopped answering while the controller still listed it as up. Opening the
 * browser and Try again spun on "Starting…" for over 90 s, then said
 * "Instafy's browser did not open. Try again." each time.
 */
describe("Shared modal on a browser session machine that stopped answering", () => {
  let root: Root;
  let container: HTMLDivElement;
  let openedAtMs = 0;
  const origin = { originId: "origin-1", endpoint: "https://ctl.test/origin/origin-1", protocols: ["http"] };
  /** The machine as the controller lists it: up, with its origin, silent since `silentSinceMs`. */
  const silent = (silentSinceMs: number) => ({ runtimeId: sessionId, status: "running", provider: "instafy-cloud",
    displayName: "Browser session", health: "offline", isLocal: false, idleTtlSeconds: 300,
    lastSeenAt: new Date(silentSinceMs).toISOString(), origin });
  const answering = () => ({ ...silent(Date.now()), status: "ready", health: "online" });
  const launching = () => ({ ...silent(Date.now()), status: "requested", health: "offline", lastSeenAt: null, origin: null });
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpProps.length = 0;
    openedAtMs = Date.now();
    mocks.ensure.mockReset().mockResolvedValue({ runtimeId: sessionId });
    mocks.requestAccessToken.mockReset().mockImplementation(async (params: { originId: string }) =>
      ({ token: `token-${params.originId}`, endpoint: `https://ctl.test/origin/${params.originId}`, expiresIn: 300 }));
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} presentation="docked" fillContainer
      canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]} />); });
    await advance(0);
  }
  async function advance(ms: number) {
    for (let left = ms; left > 0; left -= 1_000) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(1_000, left)); });
    if (ms === 0) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  async function advanceTo(sinceOpenMs: number) {
    await advance(openedAtMs + sinceOpenMs - Date.now());
  }
  const sentence = () => document.querySelector('[data-testid="browser-session-view-sentence"]')?.textContent ?? null;
  const text = () => document.body.textContent ?? "";

  it("waits for the machine to answer again instead of connecting to its silent origin, and then opens it", async () => {
    // Its runtime started again: the machine answers again 100 s after the open.
    const silentSinceMs = openedAtMs - 30_000;
    mocks.fetchStatus.mockReset().mockImplementation(async () =>
      ({ runtimes: [Date.now() - openedAtMs >= 100_000 ? answering() : silent(silentSinceMs)], preferredRuntimeId: null }));
    await render();
    await advanceTo(30_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    await advanceTo(75_000);
    expect(sentence()).toBe(SHARED_BROWSER_HOST_COPY.stillStartingMachine);
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    await advanceTo(115_000);
    expect(mocks.requestAccessToken).toHaveBeenCalledWith(expect.objectContaining({ originId: "origin-1", preferRuntime: sessionId }));
    await act(async () => { mocks.cdpProps[mocks.cdpProps.length - 1]!.onConnected(); });
    expect(sentence()).toBeNull();
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
  });

  it("asks the controller again once the machine has been silent past its idle time, and opens the new launch", async () => {
    // Silent for four minutes already: within its five-minute idle time the
    // controller hands the silent generation back to a press.
    const silentSinceMs = openedAtMs - 240_000;
    let relaunchedAtMs: number | null = null;
    mocks.fetchStatus.mockReset().mockImplementation(async () => {
      if (relaunchedAtMs === null) return { runtimes: [silent(silentSinceMs)], preferredRuntimeId: null };
      return { runtimes: [Date.now() - relaunchedAtMs >= 120_000 ? answering() : launching()], preferredRuntimeId: null };
    });
    mocks.ensure.mockImplementation(async () => {
      if (mocks.ensure.mock.calls.length > 1) relaunchedAtMs = Date.now();
      return { runtimeId: sessionId };
    });
    await render();
    await advanceTo(50_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    await advanceTo(75_000);
    // Past its idle time: the same machine is asked for again, by its id.
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(mocks.ensure.mock.calls[1]![0]).toMatchObject({ runtimeId: sessionId, displayName: "Browser session" });
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    await advanceTo(210_000);
    expect(mocks.requestAccessToken).toHaveBeenCalled();
    await act(async () => { mocks.cdpProps[mocks.cdpProps.length - 1]!.onConnected(); });
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });

  it("says it did not open, without waiting, when the machine has stopped and nothing starts it", async () => {
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [{ ...silent(openedAtMs), status: "stopped" }], preferredRuntimeId: null });
    await render();
    await advanceTo(5_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
  });
});
