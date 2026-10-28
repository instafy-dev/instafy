// @vitest-environment jsdom
//
// Live drive, Oct 28: once Octo took control of a Shared Browser whose only
// viewer is RFB (the controller's own lane), the view flickered between
// "Reconnecting…" and the normal "Octo has control · Take over" while the
// tab made ~7,300 requests (the approval read many times a second, each with
// a preflight). The view's own notice turned it "failed", Studio then stopped
// reading the tab list and emptied it, the empty list closed the roster
// socket, the missing roster turned the view back to "connecting", the tab
// list came back, the roster socket opened again, and so on, ten times a
// second. The host below plays Studio's part (ChatPanel reads the tabs only
// while the view is opening or live), with the real roster socket and the
// real approval poll.

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  requestAccessToken: vi.fn(),
  fetchPendingApproval: vi.fn(),
  rfb: [] as Array<{ listeners: Record<string, () => void>; frame: () => void }>,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: vi.fn(), stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: {
    fetchHost: vi.fn(), startHost: vi.fn(), isUnavailableError: () => false, isHostRefusedError: () => false,
    fetchPendingApproval: (...args: unknown[]) => mocks.fetchPendingApproval(...args),
    decideApproval: vi.fn(),
  },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken,
    requestAccessTokenResult: async (params: unknown) => ({ ok: true, token: await mocks.requestAccessToken(params) }),
  } },
} }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
vi.mock("../browserSessionRfbFrame", () => ({
  observeBrowserRfbFrames: (rfb: { frame?: () => void }, onFrame: () => void) => { rfb.frame = onFrame; return () => {}; },
}));
vi.mock("@novnc/novnc/lib/rfb", () => ({ default: class {
  listeners: Record<string, () => void> = {};
  frame: () => void = () => {};
  viewOnly = false;
  disconnect = vi.fn();
  addEventListener(type: string, listener: () => void) { this.listeners[type] = listener; }
  constructor() { mocks.rfb.push(this); }
} }));

import { BrowserSessionModal, RECONNECTING_GRACE_MS } from "../BrowserSessionModal";
import { hostedBrowserPagesActive, type HostedBrowserViewKind } from "../hostedBrowserViewState";
import type { BrowserSessionPage } from "../browserSessionPages";
import type { SharedBrowserCollaborationControlOwner } from "../sharedBrowserCollaboration";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const page: BrowserSessionPage = { id: "PAGE1", label: "Visit Lisboa", title: "Visit Lisboa", lastReferencedAt: 0,
  host: "visitlisboa.com", url: "https://www.visitlisboa.com/", isActive: true };
const noop = () => {};
/** How long Studio's tab read takes to answer once the view asks for tabs again. */
const PAGE_READ_MS = 30;

/** The origin's collaboration socket: it answers a join with the roster. */
const server = {
  owner: { kind: "human", participantId: "self" } as SharedBrowserCollaborationControlOwner | null,
  revision: 0,
  sockets: [] as FakeSocket[],
  opened: 0,
};
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(readonly url: string) {
    server.opened += 1;
    server.sockets.push(this);
    setTimeout(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.emit("open", {});
    }, 5);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener() {}
  send(raw: string) {
    const message = JSON.parse(raw) as { type: string };
    if (message.type === "join") {
      setTimeout(() => {
        this.receive({ type: "welcome", participantId: "self" });
        this.pushState();
      }, 5);
    }
  }
  pushState() {
    if (this.readyState !== FakeSocket.OPEN) return;
    this.receive({ type: "state", revision: ++server.revision, requests: [], controlOwner: server.owner,
      participants: [{ id: "self", displayName: "You", color: "#123456", pageId: null, cursor: null, canControl: true }] });
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    setTimeout(() => this.emit("close", {}), 0);
  }
  private receive(message: unknown) {
    if (this.readyState === FakeSocket.OPEN) this.emit("message", { data: JSON.stringify(message) });
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

/** Studio's part: tabs are read only while the view is opening or live. */
function Host({ agentHolds }: { agentHolds: boolean }) {
  const [kind, setKind] = useState<HostedBrowserViewKind | null>(null);
  const pagesActive = hostedBrowserPagesActive(kind);
  const [pages, setPages] = useState<BrowserSessionPage[]>([]);
  useEffect(() => {
    if (!pagesActive) {
      setPages([]);
      return;
    }
    const timer = setTimeout(() => setPages([page]), PAGE_READ_MS);
    return () => clearTimeout(timer);
  }, [pagesActive]);
  return <BrowserSessionModal isOpen onOpenChange={noop} projectId={projectId} currentUserId="user-1"
    browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
    presentation="docked" fillContainer canControlBrowser canClearBrowserData
    controlOwner={agentHolds ? { kind: "agent", displayName: "Octo" } : { kind: "human" }}
    onTakeOverAgent={async () => true} spaceBusy={agentHolds}
    onViewStateChange={setKind}
    sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
    sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={["rfb"]}
    sharedBrowserRfbCapabilities={{ renderScale: 1, maxFramebufferPixels: 8_294_400 }}
    sharedBrowserChrome={{ pages, resolved: true, pendingAction: null, error: null,
      onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />;
}

describe("Shared Browser while Octo holds an RFB-only browser", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    server.owner = { kind: "human", participantId: "self" }; server.sockets = []; server.opened = 0; server.revision = 0;
    mocks.rfb.length = 0;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    mocks.fetchPendingApproval.mockReset().mockResolvedValue(null);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(console, "log").mockImplementation(() => {});
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  /** Steps the clock in small acts, so each step's effects run before the next timers. */
  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(10, ms - elapsed)); await vi.dynamicImportSettled(); });
    }
  }
  const reconnecting = () => document.querySelector('[data-testid="browser-session-reconnecting"]') !== null;
  const takeOver = () => document.querySelector('[data-testid="browser-agent-surface-takeover"]') !== null;
  const recovery = () => document.querySelector('[data-testid="browser-session-error-retry"]') !== null;

  /** The person drives and sees the page; then Octo's run takes control. */
  async function octoTakesControl() {
    await act(async () => root.render(<Host agentHolds={false} />));
    await advance(1_000);
    expect(mocks.rfb).toHaveLength(1);
    await act(async () => { mocks.rfb[0]!.listeners.connect?.(); mocks.rfb[0]!.frame(); });
    await advance(100);
    expect(reconnecting()).toBe(false);
    server.owner = { kind: "agent", displayName: "Octo" };
    await act(async () => {
      for (const socket of server.sockets) socket.pushState();
      root.render(<Host agentHolds />);
    });
  }

  /** Samples what the view shows every 10 ms: each change of what is on screen. */
  async function watch(ms: number) {
    const seen: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      await advance(10);
      const now = reconnecting() ? "reconnecting" : recovery() ? "recovery" : takeOver() ? "take-over" : "other";
      if (seen.at(-1) !== now) seen.push(now);
    }
    return seen;
  }

  it("keeps one steady view with Take over and one roster socket, instead of cycling", async () => {
    await octoTakesControl();
    const socketsBefore = server.opened;
    const seen = await watch(3_000);
    // The roster socket stays open: no reconnect at all.
    expect(server.opened - socketsBefore).toBe(0);
    // One steady state: Octo has control, Take over, no "Reconnecting…".
    expect(seen).toEqual(["take-over"]);
  });

  it("stays on Take over while the roster socket keeps dropping and coming back", async () => {
    await octoTakesControl();
    await advance(500);
    const readsBefore = mocks.fetchPendingApproval.mock.calls.length;
    const seen: string[] = [];
    // The origin drops the roster socket right after each welcome, for six
    // seconds: every reconnect comes back within a second.
    for (let elapsed = 0; elapsed < 6_000; elapsed += 50) {
      for (const socket of server.sockets) if (socket.readyState === FakeSocket.OPEN) socket.close();
      await advance(50);
      const now = reconnecting() ? "reconnecting" : recovery() ? "recovery" : takeOver() ? "take-over" : "other";
      if (seen.at(-1) !== now) seen.push(now);
    }
    expect(seen).toEqual(["take-over"]);
    // A run is active: one approval read every 1.5 s, whatever the socket does.
    expect(mocks.fetchPendingApproval.mock.calls.length - readsBefore).toBeLessThanOrEqual(5);
  });

  it("keeps its roster while it shows a notice that empties Studio's tab list", async () => {
    await act(async () => root.render(<Host agentHolds={false} />));
    await advance(1_000);
    await act(async () => { mocks.rfb[0]!.listeners.connect?.(); mocks.rfb[0]!.frame(); });
    await advance(100);
    // Nobody holds control now: the RFB-only browser asks this person to
    // request it. Studio stops reading tabs for a view that is not live.
    server.owner = null;
    await act(async () => { for (const socket of server.sockets) socket.pushState(); });
    const socketsBefore = server.opened;
    const readsBefore = mocks.fetchPendingApproval.mock.calls.length;
    const seen = await watch(3_000);
    expect(server.opened - socketsBefore).toBe(0);
    expect(seen).toEqual(["recovery"]);
    expect(mocks.fetchPendingApproval.mock.calls.length - readsBefore).toBeLessThanOrEqual(1);
  });

  it("reads the approval prompt at its own cadence, not once per cycle", async () => {
    await octoTakesControl();
    const readsBefore = mocks.fetchPendingApproval.mock.calls.length;
    await advance(6_000);
    // A run is active: one read every 1.5 s, at most five in six seconds.
    expect(mocks.fetchPendingApproval.mock.calls.length - readsBefore).toBeLessThanOrEqual(5);
  });

  it("shows Reconnecting… only after the picture has been gone for the grace period", async () => {
    await act(async () => root.render(<Host agentHolds={false} />));
    await advance(1_000);
    await act(async () => { mocks.rfb[0]!.listeners.connect?.(); mocks.rfb[0]!.frame(); });
    await advance(100);
    // The picture drops: an automatic reconnect is on its way.
    await act(async () => { mocks.rfb[0]!.listeners.disconnect?.(); });
    await advance(RECONNECTING_GRACE_MS - 100);
    expect(reconnecting()).toBe(false);
    await advance(200);
    expect(reconnecting()).toBe(true);
    // The reconnect's new viewer paints: the note goes at once.
    await advance(2_000);
    expect(mocks.rfb.length).toBeGreaterThan(1);
    await act(async () => { mocks.rfb.at(-1)!.listeners.connect?.(); mocks.rfb.at(-1)!.frame(); });
    await advance(10);
    expect(reconnecting()).toBe(false);
  });

  it("never shows Reconnecting… for a reconnect that comes back within the grace period", async () => {
    await act(async () => root.render(<Host agentHolds={false} />));
    await advance(1_000);
    await act(async () => { mocks.rfb[0]!.listeners.connect?.(); mocks.rfb[0]!.frame(); });
    await advance(100);
    const seen: string[] = [];
    for (let blip = 0; blip < 3; blip += 1) {
      await act(async () => { mocks.rfb.at(-1)!.listeners.disconnect?.(); });
      // The automatic reconnect waits 1 s, then the new viewer paints at once.
      for (let elapsed = 0; elapsed < 1_200; elapsed += 50) {
        await advance(50);
        if (reconnecting()) seen.push("reconnecting");
      }
      await act(async () => { mocks.rfb.at(-1)!.listeners.connect?.(); mocks.rfb.at(-1)!.frame(); });
      await advance(50);
    }
    expect(seen).toEqual([]);
  });
});
