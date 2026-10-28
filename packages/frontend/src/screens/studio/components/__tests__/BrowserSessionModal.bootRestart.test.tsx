// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeUnavailableError extends Error {
  constructor(readonly code: string | null) {
    super(`browser pages unavailable (503): ${code ?? ""}`);
  }
}

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  ensure: vi.fn(),
  fetchPages: vi.fn(),
  requestAccessToken: vi.fn(),
  cdpProps: [] as Array<{ onConnected: () => void }>,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: mocks.ensure, stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: {
    fetchHost: vi.fn(),
    startHost: vi.fn(),
    fetchPages: mocks.fetchPages,
    isUnavailableError: (error: unknown) => error instanceof FakeUnavailableError,
    isHostRefusedError: () => false,
  },
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
 * Live test, Oct 27: on a browser session machine whose boot-time Chromium had
 * exited, the machine stayed up and Studio said "Instafy's browser did not
 * open. Try again." on every try. The machine now starts its browser again and
 * its origin says so (503 `browser_restarting`, or `browser_stopped` once it
 * gave up); the view waits, or says why it cannot open.
 */
describe("Shared modal on a browser session machine whose browser stopped", () => {
  let root: Root;
  let container: HTMLDivElement;
  const origin = { originId: "origin-1", endpoint: "https://ctl.test/origin/origin-1", protocols: ["http"] };
  const answering = () => ({ runtimeId: sessionId, status: "ready", provider: "instafy-cloud",
    displayName: "Browser session", health: "online", isLocal: false, idleTtlSeconds: 300,
    lastSeenAt: new Date().toISOString(), origin });
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpProps.length = 0;
    mocks.fetchStatus.mockReset().mockImplementation(async () => ({ runtimes: [answering()], preferredRuntimeId: null }));
    mocks.ensure.mockReset().mockResolvedValue({ runtimeId: sessionId });
    mocks.fetchPages.mockReset();
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
  const sentence = () => document.querySelector('[data-testid="browser-session-view-sentence"]')?.textContent ?? null;
  const text = () => document.body.textContent ?? "";

  it("says its browser is starting again and opens it once it runs", async () => {
    // The machine starts its browser again within five seconds.
    let restarted = false;
    setTimeout(() => { restarted = true; }, 5_000);
    mocks.fetchPages.mockImplementation(async () => {
      if (!restarted) throw new FakeUnavailableError("browser_restarting");
      return [];
    });
    await render();
    await advance(2_000);
    expect(sentence()).toBe(SHARED_BROWSER_HOST_COPY.restarting);
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    expect(mocks.fetchPages).toHaveBeenCalledWith(expect.objectContaining({ projectId, preferRuntimeId: sessionId }));

    await advance(6_000);
    expect(mocks.requestAccessToken).toHaveBeenCalledWith(expect.objectContaining({ originId: "origin-1", preferRuntime: sessionId }));
    await act(async () => { mocks.cdpProps[mocks.cdpProps.length - 1]!.onConnected(); });
    expect(sentence()).toBeNull();
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    // It read every two seconds while it waited, not faster.
    expect(mocks.fetchPages.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("says the browser stopped for good, with no Try again, once the machine gave up on it", async () => {
    mocks.fetchPages.mockRejectedValue(new FakeUnavailableError("browser_stopped"));
    await render();
    await advance(1_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.stoppedForGood);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    expect(document.querySelector('[data-testid="browser-session-error-retry"]')).toBeNull();
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
  });

  it("connects as before when the origin says nothing about its browser", async () => {
    mocks.fetchPages.mockRejectedValue(new FakeUnavailableError(null));
    await render();
    await advance(1_000);
    expect(mocks.fetchPages).toHaveBeenCalledTimes(1);
    expect(mocks.requestAccessToken).toHaveBeenCalled();
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.restarting);
  });
});
