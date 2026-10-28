// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpScreencastViewerProps } from "../CdpScreencastViewer";

type Viewer = {
  canvas: HTMLCanvasElement;
  listeners: Record<string, () => void>;
  disconnect: ReturnType<typeof vi.fn>;
  viewOnly: boolean;
  _framebufferUpdate: () => boolean;
  _display: { flush: () => Promise<void> };
};
const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(), requestAccessToken: vi.fn(), ownsControl: true,
  rosterReady: true, cdpUrls: [] as string[], instances: [] as Viewer[], clear: null as null | (() => void),
  cdpSurface: false, cdpCallbacks: null as CdpScreencastViewerProps | null,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: vi.fn(), stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: { fetchHost: vi.fn(), startHost: vi.fn(), isUnavailableError: () => false, isHostRefusedError: () => false },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken,
    requestAccessTokenResult: async (params: unknown) => ({ ok: true, token: await mocks.requestAccessToken(params) }),
  } },
} }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
vi.mock("../SharedBrowserDataClearAction", () => ({ SharedBrowserDataClearAction: ({ onClearStart }: { onClearStart: () => void }) => { mocks.clear = onClearStart; return null; } }));
vi.mock("../useSharedBrowserApproval", () => ({ useSharedBrowserApproval: () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: vi.fn() }) }));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
vi.mock("../useSharedBrowserCollaboration", () => ({ useSharedBrowserCollaboration: ({ active }: { active: boolean }) => ({
  client: { connectionStatus: active ? "connected" : "idle", participantId: active && mocks.rosterReady ? "self" : null,
    state: active && mocks.rosterReady ? { revision: 1, participants: [], requests: [], controlOwner: { kind: "human", participantId: mocks.ownsControl ? "self" : "other" } } : null, error: null },
  publishCursor: () => {}, requestControl: () => {}, takeControl: () => {}, releaseControl: () => {}, grantControl: () => {},
}) }));
vi.mock("../CdpScreencastViewer", () => ({ CdpScreencastViewer: (props: CdpScreencastViewerProps) => {
  mocks.cdpUrls.push(props.wsUrl);
  mocks.cdpCallbacks = props;
  return mocks.cdpSurface ? <canvas width={640} height={480} data-testid="shared-browser-cdp-screencast" /> : null;
} }));
vi.mock("@novnc/novnc/lib/rfb", () => ({ default: class {
  canvas: HTMLCanvasElement;
  get _canvas() { return this.canvas; }
  listeners: Record<string, () => void> = {};
  viewOnly = false;
  _FBU = { encoding: 0 };
  _display = { flush: async () => undefined };
  _handleRect() { return true; }
  _framebufferUpdate() { return this._handleRect(); }
  disconnect = vi.fn(() => this.canvas.remove());
  addEventListener(type: string, listener: () => void) { this.listeners[type] = listener; }
  constructor(container: HTMLDivElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 640; this.canvas.height = 480;
    container.append(this.canvas); mocks.instances.push(this);
  }
} }));
import { BrowserSessionModal } from "../BrowserSessionModal";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nextRuntimeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const session = (id: string) => ({ runtimeId: id, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: `origin-${id}`, endpoint: "https://origin.test", protocols: ["http"] } });
const noop = () => {};
const picture = "data:image/jpeg;base64,cGFpbnRlZC1wYWdl";

describe("Shared browser retained frames", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.instances.length = 0; mocks.cdpUrls.length = 0; mocks.ownsControl = true; mocks.rosterReady = true; mocks.clear = null;
    mocks.cdpSurface = false; mocks.cdpCallbacks = null;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session(runtimeId), session(nextRuntimeId)] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(picture);
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
  async function render(options: { active?: boolean; open?: boolean; runtime?: string; page?: string; user?: string; project?: string; browserSession?: string } = {}) {
    await act(async () => root.render(<BrowserSessionModal isOpen={options.open ?? true} transportActive={options.active ?? true}
      onOpenChange={noop} projectId={options.project ?? projectId} currentUserId={options.user ?? "user-1"}
      browserSessionId={options.browserSession ?? "browser-session-1"} preferRuntimeId={null} resumeRuntimeId={options.runtime ?? runtimeId}
      presentation="docked" fillContainer canControlBrowser canClearBrowserData sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={["rfb", "cdp-screencast"]}
      sharedBrowserRfbCapabilities={{ renderScale: 1, maxFramebufferPixels: 8_294_400 }}
      sharedBrowserChrome={{ pages: [{ id: options.page ?? "page-1", label: "Example", title: "Example", lastReferencedAt: 0, host: "example.test", url: "https://example.test", isActive: true }],
        resolved: true, pendingAction: null, error: null, onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await vi.dynamicImportSettled(); });
  }
  const latest = () => mocks.instances.at(-1)!;
  const frozen = () => document.querySelector<HTMLImageElement>('[data-testid="browser-session-frozen-frame"]');
  async function paint() { await act(async () => { latest().listeners.connect(); latest()._framebufferUpdate(); }); }
  async function hidePaintedPage() { await render(); expect(mocks.instances).toHaveLength(1); await paint(); await render({ active: false }); }

  it("waits for pixels instead of reporting Ready at the initial RFB handshake", async () => {
    await render({ project: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    const stateCard = () => document.querySelector('[data-testid="browser-session-state-card"]');
    expect(stateCard()).not.toBeNull();
    await act(async () => latest().listeners.connect());
    expect(stateCard()).not.toBeNull();
    await act(async () => latest()._framebufferUpdate());
    expect(stateCard()).toBeNull();
  });

  // A local test on a phone in light mode: around the live page the Browser
  // view stayed black, so its chrome read as dark while Chat turned light.
  it("puts a live page, and its retained picture, on a stage that follows the theme", async () => {
    await render();
    await paint();
    const stage = document.querySelector('[data-testid="browser-session-viewport"]')!.className.split(/\s+/);
    expect(stage).toEqual(expect.arrayContaining(["bg-slate-100", "dark:bg-black"]));
    expect(stage).not.toContain("bg-black");
    await render({ active: false });
    const retained = frozen()!.className.split(/\s+/);
    expect(retained).toEqual(expect.arrayContaining(["bg-slate-100", "dark:bg-black"]));
    expect(retained).not.toContain("bg-black");
  });

  it("disconnects when hidden and retains pixels while the returning collaboration roster loads", async () => {
    await hidePaintedPage();
    const first = latest();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(first.viewOnly).toBe(true);
    expect(frozen()?.src).toBe(picture);
    expect(document.querySelector('[data-shared-browser-viewer]')?.getAttribute("data-shared-browser-viewer")).toBe("rfb");
    mocks.rosterReady = false;
    await render();
    expect(mocks.cdpUrls.length).toBeGreaterThan(0);
    expect(mocks.cdpUrls.every(url => new URL(url).pathname.endsWith("/browser/screencast"))).toBe(true);
    expect(mocks.instances).toHaveLength(1);
    expect(frozen()?.src).toBe(picture);

  });

  it("does not replace retained pixels with a fallback canvas that fails before its first frame", async () => {
    await hidePaintedPage();
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(1);
    mocks.rosterReady = false;
    mocks.cdpSurface = true;
    await render();
    expect(document.querySelector('[data-testid="shared-browser-cdp-screencast"]')).not.toBeNull();
    expect(frozen()?.src).toBe(picture);
    await act(async () => mocks.cdpCallbacks!.onDisconnected({ connected: false, reason: "first frame timed out" }));
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(1);
    expect(frozen()?.src).toBe(picture);
  });

  it("captures the replacement canvas after that renderer has actually painted", async () => {
    await hidePaintedPage();
    mocks.rosterReady = false;
    mocks.cdpSurface = true;
    await render();
    const replacement = document.querySelector<HTMLCanvasElement>('[data-testid="shared-browser-cdp-screencast"]');
    expect(replacement).not.toBeNull();
    await act(async () => mocks.cdpCallbacks!.onConnected());
    expect(frozen()).toBeNull();
    await act(async () => mocks.cdpCallbacks!.onDisconnected({ connected: true, reason: "renderer disconnected" }));
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(2);
    const context = replacement!.getContext("2d");
    expect(context?.drawImage).toHaveBeenLastCalledWith(replacement, 0, 0, 640, 480);
    expect(frozen()?.src).toBe(picture);
  });

  it.each([
    { open: false }, { runtime: nextRuntimeId }, { page: "page-2" },
    { user: "user-2" }, { project: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, { browserSession: "browser-session-2" },
  ])("never reuses a retained frame after changing scope %j", async options => {
    await hidePaintedPage();
    expect(frozen()?.src).toBe(picture);
    await render({ active: false, ...options });
    expect(frozen()).toBeNull();
  });

  it("keeps the RFB connection when selecting a different page and clears old capture proof", async () => {
    await render(); await paint();
    const first = latest();
    await render({ page: "page-2" });
    expect(mocks.instances).toHaveLength(1);
    expect(first.disconnect).not.toHaveBeenCalled();
    await render({ active: false, page: "page-2" });
    expect(frozen()).toBeNull();
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });

  it("retains the new page only after it has painted on the existing connection", async () => {
    await render(); await paint();
    const first = latest();
    await render({ page: "page-2" });
    await act(async () => first._framebufferUpdate());
    await render({ active: false, page: "page-2" });
    expect(mocks.instances).toHaveLength(1);
    expect(frozen()?.src).toBe(picture);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(1);
  });

  it("invalidates old authenticated pixels before a replacement origin can reconnect on the same runtime", async () => {
    await render(); await paint();
    const first = latest();
    mocks.fetchStatus.mockResolvedValue({ runtimes: [{ ...session(runtimeId), origin: { originId: "replacement-origin", endpoint: "https://new-origin.test", protocols: ["http"] } }] });
    await act(async () => first.listeners.disconnect());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(mocks.requestAccessToken).toHaveBeenLastCalledWith(expect.objectContaining({ originId: "replacement-origin" }));
    expect(frozen()).toBeNull();
    const capturesAfterOriginChange = vi.mocked(HTMLCanvasElement.prototype.toDataURL).mock.calls.length;
    await render({ active: false });
    expect(frozen()).toBeNull();
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(capturesAfterOriginChange);
  });

  it("still tears down the combined RFB socket when another participant takes control", async () => {
    await render(); await paint();
    const first = latest();
    mocks.ownsControl = false;
    await render();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(first.viewOnly).toBe(true);
    expect(mocks.instances).toHaveLength(1);
  });

  it("discards the retained authenticated page before clearing browser data", async () => {
    await render(); await paint();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    expect(mocks.clear).toBeTypeOf("function");
    await render({ active: false });
    expect(frozen()).not.toBeNull();
    await act(async () => mocks.clear!());
    expect(frozen()).toBeNull();
  });
});
