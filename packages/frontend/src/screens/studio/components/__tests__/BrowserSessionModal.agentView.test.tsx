// @vitest-environment jsdom
//
// Live drive, Oct 28: while Octo drove an RFB-only browser, the person's
// Browser view showed a still of the page an earlier chat had left
// (roborock's error page) for 2 min 25 s under a visitlisboa.com address, and
// a black stage while Octo worked in a tab of its own. It had two Take over
// buttons, and the caption of Octo's last step stayed after the turn.

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBrowserSessionAction } from "../../../../sdk/instafy";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  requestAccessToken: vi.fn(),
  fetchPendingApproval: vi.fn(),
  actions: [] as RuntimeBrowserSessionAction[],
  // Whether Studio has read the action log yet (the newest step it found).
  logRead: true,
  rfb: [] as Array<{ url: string; viewOnly: boolean; resizeSession?: boolean; listeners: Record<string, () => void>; frame: () => void;
    canvas: HTMLCanvasElement; disconnect: ReturnType<typeof vi.fn> }>,
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
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: mocks.actions, latestClick: null,
  logSeq: mocks.logRead ? mocks.actions.reduce((latest, action) => Math.max(latest, action.seq), 0) : null }) }));
vi.mock("../browserSessionRfbFrame", () => ({
  observeBrowserRfbFrames: (rfb: { frame?: () => void }, onFrame: () => void) => { rfb.frame = onFrame; return () => {}; },
}));
vi.mock("@novnc/novnc/lib/rfb", () => ({ default: class {
  listeners: Record<string, () => void> = {};
  frame: () => void = () => {};
  viewOnly = false;
  canvas: HTMLCanvasElement;
  get _canvas() { return this.canvas; }
  disconnect = vi.fn(() => this.canvas.remove());
  addEventListener(type: string, listener: () => void) { this.listeners[type] = listener; }
  url: string;
  constructor(container: HTMLDivElement, url: string) {
    this.url = url;
    this.canvas = document.createElement("canvas");
    this.canvas.width = 640; this.canvas.height = 480;
    container.append(this.canvas);
    mocks.rfb.push(this);
  }
} }));

// The event loop React schedules its work on, kept before the fake timers
// replace it.
const realSetImmediate: (callback: () => void) => void = globalThis.setImmediate;

import { BrowserSessionModal } from "../BrowserSessionModal";
import { hostedBrowserPagesActive, type HostedBrowserViewKind } from "../hostedBrowserViewState";
import type { BrowserSessionPage } from "../browserSessionPages";
import type { SharedBrowserCollaborationControlOwner } from "../sharedBrowserCollaboration";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const noop = () => {};

const server = {
  owner: { kind: "human", participantId: "self" } as SharedBrowserCollaborationControlOwner | null,
  revision: 0,
  sockets: [] as FakeSocket[],
};
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(readonly url: string) {
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
    if ((JSON.parse(raw) as { type: string }).type === "join") {
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

type HostProps = {
  agentHolds: boolean;
  viewOnly?: boolean;
  conversationId?: string;
  pageUrl?: string;
  agentPageIds?: string[];
  hidden?: boolean;
};

/** Studio's part: tabs are read only while the view is opening or live. */
function Host({ agentHolds, viewOnly = false, conversationId = "chat-a", pageUrl = "https://www.visitlisboa.com/",
  agentPageIds, hidden = false }: HostProps) {
  const [kind, setKind] = useState<HostedBrowserViewKind | null>(null);
  const pagesActive = hostedBrowserPagesActive(kind);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!pagesActive) {
      setReady(false);
      return;
    }
    const timer = setTimeout(() => setReady(true), 30);
    return () => clearTimeout(timer);
  }, [pagesActive]);
  const host = new URL(pageUrl).host;
  const pages: BrowserSessionPage[] = ready
    ? [{ id: "PAGE1", label: host, title: host, lastReferencedAt: 0, host, url: pageUrl, isActive: true }]
    : [];
  return <BrowserSessionModal isOpen onOpenChange={noop} projectId={projectId} currentUserId="user-1"
    browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
    presentation="docked" fillContainer canControlBrowser canClearBrowserData transportActive={!hidden}
    controlOwner={agentHolds ? { kind: "agent", displayName: "Octo" } : { kind: "human" }}
    onTakeOverAgent={async () => true} spaceBusy={agentHolds}
    onViewStateChange={setKind} conversationId={conversationId}
    sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
    sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={["rfb"]}
    sharedBrowserRfbCapabilities={{ renderScale: 1, maxFramebufferPixels: 8_294_400, ...(viewOnly ? { viewOnly: true } : {}) }}
    sharedBrowserChrome={{ pages, resolved: true, pendingAction: null, error: null, agentPageIds,
      onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />;
}

function action(seq: number, label: string): RuntimeBrowserSessionAction {
  return { seq, ts: seq, pageId: "PAGE1", type: "navigate", label, url: null, x: null, y: null, viewportW: null, viewportH: null };
}

describe("Shared Browser view while Octo drives", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    server.owner = { kind: "human", participantId: "self" }; server.sockets = []; server.revision = 0;
    mocks.rfb.length = 0;
    mocks.actions = [];
    mocks.logRead = true;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    mocks.fetchPendingApproval.mockReset().mockResolvedValue(null);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(console, "log").mockImplementation(() => {});
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/jpeg;base64,c3RpbGw=");
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(10, ms - elapsed)); await vi.dynamicImportSettled(); });
    }
  }
  const still = () => document.querySelector('[data-testid="browser-session-frozen-frame"]');
  const whereabouts = () => document.querySelector('[data-testid="browser-session-agent-whereabouts"]')?.textContent ?? null;
  const takeOverButtons = () => document.querySelectorAll(
    '[data-testid="browser-agent-surface-takeover"], [data-testid="browser-reading-takeover"]',
  ).length;
  const ticker = () => document.querySelector('[data-testid="browser-action-ticker"]')?.textContent ?? null;

  let driverLanes = 0;
  /** The person drives and sees the page; then Octo's run takes control. */
  async function octoTakesControl(props: Omit<HostProps, "agentHolds"> = {}) {
    await act(async () => root.render(<Host agentHolds={false} {...props} />));
    await advance(1_000);
    // The person drives over the driver's lane.
    const driving = mocks.rfb.at(-1)!;
    expect(driving.url).toMatch(/\/browser\/vnc\?/);
    expect(driving.viewOnly).toBe(false);
    await act(async () => { driving.listeners.connect?.(); driving.frame(); });
    await advance(100);
    driverLanes = mocks.rfb.length;
    server.owner = { kind: "agent", displayName: "Octo" };
    await act(async () => {
      for (const socket of server.sockets) socket.pushState();
      root.render(<Host agentHolds {...props} />);
    });
    await advance(200);
  }

  it("watches Octo live over the view-only lane when the runtime serves one", async () => {
    await octoTakesControl({ viewOnly: true, agentPageIds: ["PAGE1"] });
    // The driver's lane closed, and a view-only one opened in its place.
    expect(mocks.rfb.length).toBe(driverLanes + 1);
    const lane = mocks.rfb.at(-1)!;
    expect(lane.url).toMatch(/\/browser\/vnc\/view\?/);
    expect(lane.viewOnly).toBe(true);
    // It never asks to resize the screen Octo uses.
    expect(lane.resizeSession).toBe(false);
    await act(async () => { lane.listeners.connect?.(); lane.frame(); });
    await advance(50);
    expect(still()).toBeNull();
    expect(whereabouts()).toBeNull();
    // Octo lets go: the person drives over the driver's lane again.
    server.owner = { kind: "human", participantId: "self" };
    await act(async () => {
      for (const socket of server.sockets) socket.pushState();
      root.render(<Host agentHolds={false} viewOnly agentPageIds={["PAGE1"]} />);
    });
    await advance(200);
    expect(mocks.rfb.at(-1)!.url).toMatch(/\/browser\/vnc\?/);
    expect(mocks.rfb.at(-1)!.viewOnly).toBe(false);
  });

  it("closes the view-only lane while the view is hidden, as the driver's lane does", async () => {
    await octoTakesControl({ viewOnly: true, agentPageIds: ["PAGE1"] });
    const lane = mocks.rfb.at(-1)!;
    expect(lane.url).toMatch(/\/browser\/vnc\/view\?/);
    await act(async () => { lane.listeners.connect?.(); lane.frame(); });
    await advance(50);
    const lanes = mocks.rfb.length;
    // The person goes back to Chat while Octo drives: nothing streams.
    await act(async () => root.render(<Host agentHolds viewOnly hidden agentPageIds={["PAGE1"]} />));
    await advance(200);
    expect(lane.disconnect).toHaveBeenCalled();
    expect(mocks.rfb.length).toBe(lanes);
    // Back on the Browser view, it watches again.
    await act(async () => root.render(<Host agentHolds viewOnly agentPageIds={["PAGE1"]} />));
    await advance(200);
    expect(mocks.rfb.length).toBe(lanes + 1);
    expect(mocks.rfb.at(-1)!.url).toMatch(/\/browser\/vnc\/view\?/);
  });

  it("drops the still when the chat changes, and says where Octo is instead", async () => {
    await octoTakesControl({ agentPageIds: ["PAGE1"] });
    expect(still()).not.toBeNull();
    expect(whereabouts()).toBeNull();
    await act(async () => root.render(<Host agentHolds conversationId="chat-b" agentPageIds={["PAGE1"]} />));
    await advance(50);
    expect(still()).toBeNull();
    expect(whereabouts()).toBe("Octo is on visitlisboa.com");
  });

  it("drops the still when the page goes to another address", async () => {
    await octoTakesControl({ pageUrl: "https://www.roborock.com/", agentPageIds: ["PAGE1"] });
    expect(still()).not.toBeNull();
    await act(async () => root.render(<Host agentHolds pageUrl="https://www.visitlisboa.com/" agentPageIds={["PAGE1"]} />));
    await advance(50);
    expect(still()).toBeNull();
    expect(whereabouts()).toBe("Octo is on visitlisboa.com");
  });

  it("shows one Take over, in the row of pages Octo reads", async () => {
    await octoTakesControl({ agentPageIds: ["PAGE1"] });
    expect(document.querySelector('[data-testid="browser-reading-takeover"]')).not.toBeNull();
    expect(takeOverButtons()).toBe(1);
  });

  it("never captions an earlier turn's step when the view opens during Octo's turn", async () => {
    // Drive, Oct 28: the view opened as the card was pressed, read the log
    // once Octo held the browser, and captioned the earlier chat's last step
    // ("Go to https://www.roborock.com/").
    mocks.actions = [action(1, "Go to https://www.roborock.com/")];
    mocks.logRead = false;
    server.owner = { kind: "agent", displayName: "Octo" };
    await act(async () => root.render(<Host agentHolds viewOnly agentPageIds={["PAGE1"]} />));
    await advance(1_000);
    const lane = mocks.rfb.at(-1)!;
    expect(lane.url).toMatch(/\/browser\/vnc\/view\?/);
    await act(async () => { lane.listeners.connect?.(); lane.frame(); });
    await advance(50);
    // The log is first read while Octo holds the browser.
    mocks.logRead = true;
    await act(async () => root.render(<Host agentHolds viewOnly agentPageIds={["PAGE1"]} />));
    await advance(20);
    expect(ticker()).toBeNull();
    mocks.actions = [...mocks.actions, action(2, "Click \"menu\"")];
    await act(async () => root.render(<Host agentHolds viewOnly agentPageIds={["PAGE1"]} />));
    await advance(20);
    expect(ticker()).toContain("Click \"menu\"");
  });

  it("captions only Octo's steps of this turn, and nothing once it ends", async () => {
    // A step an earlier turn left in the log.
    mocks.actions = [action(1, "Go to https://www.roborock.com/")];
    await octoTakesControl({ agentPageIds: ["PAGE1"] });
    expect(ticker()).toBeNull();
    mocks.actions = [...mocks.actions, action(2, "Click \"menu\"")];
    await act(async () => root.render(<Host agentHolds agentPageIds={["PAGE1"]} />));
    await advance(20);
    expect(ticker()).toContain("Click \"menu\"");
    // The turn ends.
    server.owner = { kind: "human", participantId: "self" };
    await act(async () => {
      for (const socket of server.sockets) socket.pushState();
      root.render(<Host agentHolds={false} agentPageIds={["PAGE1"]} />);
    });
    await advance(50);
    expect(ticker()).toBeNull();
  });
  /**
   * Control changes hands as the browser reports it, with React rendering on
   * its own schedule as it does in a browser (act flushes every render at
   * once, which hides a lane opened in between). Returns the lanes opened.
   */
  async function handOverOutsideAct(owner: SharedBrowserCollaborationControlOwner, props: HostProps) {
    const before = mocks.rfb.length;
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      server.owner = owner;
      for (const socket of server.sockets) socket.pushState();
      root.render(<Host {...props} />);
      for (let turn = 0; turn < 40; turn += 1) await new Promise<void>((resolve) => realSetImmediate(resolve));
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    }
    return mocks.rfb.slice(before).map((rfb) => `${rfb.viewOnly ? "watching" : "driving"} ${new URL(rfb.url).pathname}`);
  }

  it("opens only the view-only lane when Octo takes control, never the driver's lane in between", async () => {
    await act(async () => root.render(<Host agentHolds={false} viewOnly agentPageIds={["PAGE1"]} />));
    await advance(1_000);
    const driving = mocks.rfb.at(-1)!;
    expect(driving.url).toMatch(/\/browser\/vnc\?/);
    await act(async () => { driving.listeners.connect?.(); driving.frame(); });
    await advance(100);
    expect(await handOverOutsideAct({ kind: "agent", displayName: "Octo" },
      { agentHolds: true, viewOnly: true, agentPageIds: ["PAGE1"] })).toEqual(["watching /browser/vnc/view"]);
  });

  it("opens only the driver's lane when the person takes control back, never the view-only lane in between", async () => {
    await octoTakesControl({ viewOnly: true, agentPageIds: ["PAGE1"] });
    const lane = mocks.rfb.at(-1)!;
    expect(lane.url).toMatch(/\/browser\/vnc\/view\?/);
    await act(async () => { lane.listeners.connect?.(); lane.frame(); });
    await advance(50);
    expect(await handOverOutsideAct({ kind: "human", participantId: "self" },
      { agentHolds: false, viewOnly: true, agentPageIds: ["PAGE1"] })).toEqual(["driving /browser/vnc"]);
  });
});
