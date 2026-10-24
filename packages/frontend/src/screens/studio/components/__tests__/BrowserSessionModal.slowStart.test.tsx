// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  requestAccessToken: vi.fn(),
  fetchHost: vi.fn(),
  cdpProps: [] as Array<{ onConnected: () => void }>,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: vi.fn(), stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: { fetchHost: mocks.fetchHost, startHost: vi.fn(), isUnavailableError: () => false, isHostRefusedError: () => false },
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
const hostId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * Dogfood, Oct 24: a press opened Instafy's browser while the space's machine
 * was stopped. Its first launch on a new node came up 4 min 44 s after the
 * request, but the view had given up at three minutes ("This space's machine
 * did not start. Try again.") and stayed there.
 */
describe("Shared modal while the space's machine starts slowly", () => {
  let root: Root;
  let container: HTMLDivElement;
  const ensureSpaceMachine = vi.fn<() => Promise<boolean>>();
  const onConnectionErrorChange = vi.fn<(error: string | null) => void>();
  const hostEntry = () => ({ runtimeId: hostId, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime",
    health: "online", lastSeenAt: null, isLocal: false,
    origin: { originId: "origin-1", endpoint: "https://ctl.test/origin/origin-1", protocols: ["http"] },
    sharedBrowserHost: { version: 1, mode: "lazy" } });
  const stoppedEntry = () => ({ ...hostEntry(), status: "stopped", health: "offline", origin: null, sharedBrowserHost: undefined });
  /** A reused row on its new launch: requested, offline, never seen, with an old createdAt. */
  const launchingEntry = () => ({ ...stoppedEntry(), status: "requested", createdAt: "2026-09-02T08:00:00.000Z",
    launchRequestedAt: "2026-10-24T17:48:31.000Z" });
  const covered = (...runtimes: unknown[]) => ({ runtimes, preferredRuntimeId: null, sharedBrowserHostPolicy: "covered" });
  const host = (state: string) => ({ version: 1, mode: "lazy", state, generation: "generation-1", failure: null,
    startedByYou: false, othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false });
  let pressedAtMs = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpProps.length = 0;
    onConnectionErrorChange.mockReset();
    pressedAtMs = Date.now();
    mocks.fetchHost.mockReset().mockResolvedValue(host("ready"));
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
  async function render(options: { autoAttachToken?: number } = {}) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} presentation="docked" fillContainer
      canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
      ensureSpaceMachine={ensureSpaceMachine} conversationRuntimeId={hostId}
      onConnectionErrorChange={onConnectionErrorChange} autoAttachToken={options.autoAttachToken ?? 0} />); });
    await advance(0);
  }
  async function advance(ms: number) {
    for (let left = ms; left > 0; left -= 1_000) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(1_000, left)); });
    if (ms === 0) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  async function advanceTo(sincePressMs: number) {
    await advance(pressedAtMs + sincePressMs - Date.now());
  }
  const sentence = () => document.querySelector('[data-testid="browser-session-view-sentence"]')?.textContent ?? null;
  const text = () => document.body.textContent ?? "";
  const retryButton = () => document.querySelector<HTMLButtonElement>('[data-testid="browser-session-error-retry"]');
  /** The machine as the controller reports it: stopped before the press, launching after it, up from `upAtMs`. */
  function machineComesUpAt(upAtMs: number) {
    let pressed = false;
    mocks.fetchStatus.mockReset().mockImplementation(async () => {
      if (!pressed) return covered(stoppedEntry());
      return covered(Date.now() - pressedAtMs >= upAtMs ? hostEntry() : launchingEntry());
    });
    ensureSpaceMachine.mockReset().mockImplementation(() => new Promise((resolve) => {
      pressed = true;
      // The client's ensure answered after 53 s.
      setTimeout(() => resolve(true), 53_000);
    }));
  }

  it("keeps opening, says the machine is still starting after a minute, and attaches once it comes up", async () => {
    machineComesUpAt(289_000);
    await render();
    await advanceTo(30_000);
    expect(sentence()).toBe(SHARED_BROWSER_HOST_COPY.opening);
    await advanceTo(75_000);
    expect(sentence()).toBe("Still starting this space's machine…");
    expect(document.querySelector('[data-testid="browser-session-loading-notice"]')?.getAttribute("data-view-state")).toBe("opening");
    expect(retryButton()).toBeNull();
    // Where it used to give up.
    await advanceTo(190_000);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.machineDidNotStart);
    expect(sentence()).toBe(SHARED_BROWSER_HOST_COPY.stillStartingMachine);
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    await advanceTo(305_000);
    expect(mocks.fetchHost).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: hostId }));
    expect(mocks.requestAccessToken).toHaveBeenCalled();
    await act(async () => { mocks.cdpProps[mocks.cdpProps.length - 1]!.onConnected(); });
    expect(sentence()).toBeNull();
    expect(retryButton()).toBeNull();
    expect(onConnectionErrorChange).not.toHaveBeenCalledWith(SHARED_BROWSER_HOST_COPY.machineDidNotStart);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    // About 80 status reads over the wait, not one every 2 s.
    expect(mocks.fetchStatus.mock.calls.length).toBeLessThan(60);
  });

  it("says the machine did not start at ten minutes, and a press opens it again from the start", async () => {
    machineComesUpAt(Number.POSITIVE_INFINITY);
    await render();
    await advanceTo(9 * 60_000);
    expect(sentence()).toBe(SHARED_BROWSER_HOST_COPY.stillStartingMachine);
    await advanceTo(10 * 60_000 + 5_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.machineDidNotStart);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.stillStartingMachine);
    expect(onConnectionErrorChange).toHaveBeenLastCalledWith(SHARED_BROWSER_HOST_COPY.machineDidNotStart);
    // Try again is a new attempt: it opens, and is not slow until it has been.
    pressedAtMs = Date.now();
    await act(async () => { retryButton()!.click(); });
    await advance(5_000);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(2);
    expect(sentence()).toBe(SHARED_BROWSER_HOST_COPY.opening);
  });

  it("attaches when Studio asks after the machine came up late, without starting it again", async () => {
    // The ensure was refused and nothing launched: the view fails at once.
    mocks.fetchStatus.mockReset().mockResolvedValue(covered(stoppedEntry()));
    ensureSpaceMachine.mockReset().mockResolvedValue(false);
    await render();
    await advance(1_000);
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.machineDidNotStart);
    // Someone else's start brought it up; ChatPanel then asks once.
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    await render({ autoAttachToken: 1 });
    await advance(2_000);
    expect(mocks.requestAccessToken).toHaveBeenCalled();
    await act(async () => { mocks.cdpProps[mocks.cdpProps.length - 1]!.onConnected(); });
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.machineDidNotStart);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
  });
});
