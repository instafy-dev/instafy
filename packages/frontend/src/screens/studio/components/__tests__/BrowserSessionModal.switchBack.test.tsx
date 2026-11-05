// @vitest-environment jsdom
//
// Local test, Nov 4: back in a chat where nothing ran, its Browser view said
// "Opening Instafy's browser…", with "Starting…", for half a second while it
// found the space's browser again, though nothing was starting: the browser
// was open, on the chat's page, the whole time.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionPage } from "../browserSessionPages";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  listeners = new Map<string, Set<(event: Event & { data?: unknown }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: Event & { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  send() {}
  close() { this.readyState = 3; }
  emit(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
    }
  }
}

const mocks = vi.hoisted(() => ({ fetchStatus: vi.fn(), requestAccessToken: vi.fn() }));
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
vi.mock("../useSharedBrowserApproval", () => ({ useSharedBrowserApproval: () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: vi.fn() }) }));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
vi.mock("../useSharedBrowserCollaboration", () => ({ useSharedBrowserCollaboration: ({ active }: { active: boolean }) => ({
  client: { connectionStatus: active ? "connected" : "idle", participantId: active ? "self" : null,
    state: active ? { revision: 1, participants: [], requests: [], controlOwner: { kind: "human", participantId: "self" } } : null,
    error: null },
  publishCursor: () => {}, requestControl: () => {}, takeControl: () => {}, releaseControl: () => {}, grantControl: () => {},
}) }));
import { BrowserSessionModal, RECONNECTING_GRACE_MS } from "../BrowserSessionModal";

const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const noop = () => {};
const CHAT_TAB = "PAGE-SEVILLA";
const page: BrowserSessionPage = { id: CHAT_TAB, url: "https://visitasevilla.es/barrio-de-santa-cruz/", host: "visitasevilla.es",
  label: "visitasevilla.es", title: "Santa Cruz", lastReferencedAt: 0, isActive: true };

describe("a chat's Browser view, back in a chat where nothing runs", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    FakeWebSocket.instances = [];
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1280, height: 720, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,c3RpbGw=");
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

  async function render(projectId: string, options: { openedByPerson: boolean; arrivalSite?: string }) {
    await act(async () => root.render(<BrowserSessionModal isOpen transportActive onOpenChange={noop} projectId={projectId}
      currentUserId="user-1" browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
      presentation="docked" fillContainer canControlBrowser canClearBrowserData sharedBrowserCapabilitiesResolved
      sharedBrowserCapabilitiesAvailable sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
      conversationId="chat-sevilla" chatPageIds={[CHAT_TAB]} openedByPerson={options.openedByPerson}
      agentArrival={options.arrivalSite ? { site: options.arrivalSite } : null}
      sharedBrowserChrome={{ pages: [page], resolved: true, pendingAction: null, error: null,
        onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />));
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  async function drawFrame() {
    const socket = FakeWebSocket.instances.filter((candidate) => candidate.readyState === FakeWebSocket.OPEN &&
      new URL(candidate.url).pathname.endsWith("/browser/screencast")).at(-1)!;
    await act(async () => {
      socket.emit({ type: "ready", pageId: CHAT_TAB, width: 1280, height: 720, dpr: 1, deviceWidth: 1280, deviceHeight: 720 });
      socket.emit({ type: "frame", frameId: 1, data: "YQ==", metadata: {} });
      await Promise.resolve(); await Promise.resolve();
    });
  }
  /** What the view says while it is not live: its sentence and its status. */
  const said = () => ({
    opening: (document.body.textContent ?? "").includes("Opening Instafy's browser"),
    starting: Array.from(document.querySelectorAll('[data-testid="browser-session-status"]'))
      .some((status) => (status.textContent ?? "").includes("Starting")),
  });
  /** The chat was open, its browser showed its page, and the person went to another chat. */
  async function shownThenLeft(projectId: string) {
    await render(projectId, { openedByPerson: true });
    await advance(0);
    await drawFrame();
    await act(async () => root.unmount());
    root = createRoot(container);
    // Finding the browser again takes half a second, as it did there.
    mocks.fetchStatus.mockReset().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ runtimes: [session] }), 500);
    }));
  }

  it("says nothing about opening the browser while it finds it again", async () => {
    const space = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await shownThenLeft(space);
    await render(space, { openedByPerson: false });
    const seen: Array<ReturnType<typeof said>> = [];
    for (let step = 0; step < 5; step += 1) {
      seen.push(said());
      await advance(150);
    }
    expect(seen).toEqual(Array(5).fill({ opening: false, starting: false }));
    await advance(100);
    await drawFrame();
    expect(said()).toEqual({ opening: false, starting: false });
  });

  it("says it is opening once finding it takes longer, and at once for a press or a turn of the chat", async () => {
    const space = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await shownThenLeft(space);
    mocks.fetchStatus.mockReset().mockImplementation(() => new Promise(() => {}));
    await render(space, { openedByPerson: false });
    await advance(RECONNECTING_GRACE_MS - 100);
    expect(said().opening).toBe(false);
    await advance(200);
    expect(said().opening).toBe(true);

    // The person opened the browser themselves: it says so at once.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(space, { openedByPerson: true });
    await advance(0);
    expect(said().opening).toBe(true);

    // A turn of this chat is on its way to a site: so does it.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(space, { openedByPerson: false, arrivalSite: "visitasevilla.es" });
    await advance(0);
    expect(said().opening).toBe(true);
  });
});
