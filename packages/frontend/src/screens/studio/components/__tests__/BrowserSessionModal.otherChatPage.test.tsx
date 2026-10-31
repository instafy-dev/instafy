// @vitest-environment jsdom
//
// Local test, Oct 31: during another chat's browser turn, a chat's Browser
// view said "Octo is working in another chat" over a blank stage, but kept
// its picture stream: the hidden canvas went on drawing the other chat's live
// page, whose frames reached this person's device. Its tab list also named
// the other chat's page. In a team space that page may be another person's,
// signed in. A chat's view now asks for no picture while its stage draws no
// page of the chat, and lists only the chat's own tabs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionPage } from "../browserSessionPages";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
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
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
  emit(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
    }
  }
}

const mocks = vi.hoisted(() => ({ fetchStatus: vi.fn(), requestAccessToken: vi.fn(), webRtcConnected: null as null | (() => void) }));
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
    state: active ? { revision: 1, participants: [], requests: [], controlOwner: { kind: "human", participantId: "self" } } : null, error: null },
  publishCursor: () => {}, requestControl: () => {}, takeControl: () => {}, releaseControl: () => {}, grantControl: () => {},
}) }));
// WebRTC sends the browser's whole screen, whatever tab is in front: while it
// is mounted, its stream is open.
vi.mock("../WebRtcBrowserViewer", () => ({ WebRtcBrowserViewer: (props: { onConnected: () => void }) => {
  mocks.webRtcConnected = props.onConnected;
  return <video data-testid="shared-browser-webrtc" />;
} }));
import { BrowserSessionModal } from "../BrowserSessionModal";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const noop = () => {};

function tab(id: string, url: string, isActive: boolean): BrowserSessionPage {
  const host = new URL(url).host;
  return { id, url, host, label: host, title: host, lastReferencedAt: 0, isActive };
}
// This chat's page, and another chat's (its title names it).
const CHAT_TAB = "PAGE-LELLO";
const OTHER_TAB = "PAGE-FRAMEWORK";
const LELLO = "https://www.livrarialello.pt/";
const FRAMEWORK = "https://frame.work/at/en/laptop12";
const own = (isActive = true) => tab(CHAT_TAB, LELLO, isActive);
const other = (isActive = false) => tab(OTHER_TAB, FRAMEWORK, isActive);

describe("a chat's Browser view and another chat's page", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    FakeWebSocket.instances = [];
    mocks.webRtcConnected = null;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1280, height: 720, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
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

  async function render(options: {
    pages: BrowserSessionPage[];
    chatPageIds?: string[];
    anotherChatTurn?: boolean;
    /** The Browser view is in front (false: the person is in Chat). */
    shown?: boolean;
    viewer?: "cdp-screencast" | "webrtc";
    compact?: boolean;
    /** A space this page has not connected a browser view in yet (after a reload). */
    project?: string;
  }) {
    const viewer = options.viewer ?? "cdp-screencast";
    await act(async () => root.render(<BrowserSessionModal isOpen transportActive={options.shown ?? true}
      onOpenChange={noop} projectId={options.project ?? projectId} currentUserId="user-1"
      browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
      presentation="docked" fillContainer canControlBrowser canClearBrowserData sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind={viewer} sharedBrowserAvailableViewerKinds={[viewer]}
      conversationId="chat-lello" chatPageIds={options.chatPageIds ?? [CHAT_TAB]}
      anotherChatTurn={options.anotherChatTurn ?? false}
      sharedBrowserChrome={{ pages: options.pages, resolved: true, pendingAction: null, error: null, compact: options.compact,
        onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  /** The picture streams this view has open, by the page each one asks for. */
  const pictures = () => FakeWebSocket.instances
    .filter((socket) => socket.readyState === FakeWebSocket.OPEN && new URL(socket.url).pathname.endsWith("/browser/screencast"))
    .map((socket) => ({ socket, pageId: new URL(socket.url).searchParams.get("pageId") }));
  /** Whether the view ever asked the browser for a picture of that page. */
  const askedFor = (pageId: string) => FakeWebSocket.instances.some((socket) =>
    new URL(socket.url).pathname.endsWith("/browser/screencast") && new URL(socket.url).searchParams.get("pageId") === pageId);
  async function drawFrame(socket: FakeWebSocket) {
    await act(async () => {
      socket.emit({ type: "ready", pageId: CHAT_TAB, width: 1280, height: 720, dpr: 1, deviceWidth: 1280, deviceHeight: 720 });
      socket.emit({ type: "frame", frameId: 1, data: "YQ==", metadata: {} });
      await Promise.resolve(); await Promise.resolve();
    });
  }
  const canvas = () => document.querySelector<HTMLCanvasElement>('[data-testid="shared-browser-cdp-screencast"]');
  /** The live picture on screen: the canvas, on a surface that is not hidden. */
  const pictureShown = () => {
    const surface = canvas()?.parentElement;
    return Boolean(surface && !surface.classList.contains("invisible") && !surface.classList.contains("opacity-0"));
  };
  const note = () => document.querySelector('[data-testid="browser-session-agent-arrival"]')?.textContent ?? null;
  const text = () => document.body.textContent ?? "";

  it("asks for no picture of another chat's page during its turn, and draws the chat's own page again after", async () => {
    await render({ pages: [own(), other()] });
    expect(pictures().map((picture) => picture.pageId)).toEqual([CHAT_TAB]);
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(canvas()?.dataset.active).toBe("true");

    // Another chat's browser turn brings its page to the front.
    await render({ pages: [own(false), other(true)], anotherChatTurn: true });
    expect(note()).toBe("Octo is working in another chat");
    expect(pictures()).toEqual([]);
    expect(canvas()).toBeNull();
    // All through that turn: no stream of its page, and nothing else on screen.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(askedFor(OTHER_TAB)).toBe(false);
    expect(pictures()).toEqual([]);
    expect(note()).toBe("Octo is working in another chat");
    expect(document.querySelector('[data-testid="browser-session-reconnecting"]')).toBeNull();
    expect(text()).not.toContain("Opening Instafy's browser");

    // The turn ends and the chat's tab is in front again: its picture is
    // asked for at once, and shows with its first frame.
    await render({ pages: [own(), other()] });
    expect(pictures().map((picture) => picture.pageId)).toEqual([CHAT_TAB]);
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(askedFor(OTHER_TAB)).toBe(false);
  });

  it("asks for none with the person in Chat either, and draws the chat's page as soon as its view opens", async () => {
    await render({ pages: [own(), other()] });
    await drawFrame(pictures()[0]!.socket);
    // The person goes back to Chat: the chat's own page stays connected, so
    // the view shows it at once when it opens.
    await render({ pages: [own(), other()], shown: false });
    expect(pictures().map((picture) => picture.pageId)).toEqual([CHAT_TAB]);
    await render({ pages: [own(), other()] });
    expect(pictureShown()).toBe(true);
    expect(FakeWebSocket.instances.filter((socket) => socket.url.includes("/browser/screencast"))).toHaveLength(1);

    // Back in Chat, another chat's turn runs.
    await render({ pages: [own(), other()], shown: false });
    await render({ pages: [own(false), other(true)], anotherChatTurn: true, shown: false });
    expect(pictures()).toEqual([]);
    expect(askedFor(OTHER_TAB)).toBe(false);
    // After it, the person opens the chat's view and Studio brings its tab
    // forward: the picture is asked for at once and drawn with its first frame.
    await render({ pages: [own(false), other(true)] });
    expect(pictures()).toEqual([]);
    await render({ pages: [own(), other()] });
    expect(pictures().map((picture) => picture.pageId)).toEqual([CHAT_TAB]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(askedFor(OTHER_TAB)).toBe(false);
  });

  // After a reload, during another chat's turn: the view asks for no
  // picture, so none arrives to say it is open. It is open all the same.
  it("is open, not opening, when it opens during another chat's turn", async () => {
    const reloaded = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await render({ pages: [own(false), other(true)], anotherChatTurn: true, project: reloaded });
    expect(askedFor(OTHER_TAB)).toBe(false);
    expect(pictures()).toEqual([]);
    expect(note()).toBe("Octo is working in another chat");
    expect(text()).not.toContain("Opening Instafy's browser");
    // Once that turn is over and the chat's tab is in front, its picture comes.
    await render({ pages: [own(), other()], project: reloaded });
    expect(pictures().map((picture) => picture.pageId)).toEqual([CHAT_TAB]);
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
  });

  it("closes a WebRTC picture, which sends the whole screen, during another chat's turn", async () => {
    await render({ pages: [own(), other()], viewer: "webrtc" });
    expect(document.querySelector('[data-testid="shared-browser-webrtc"]')).not.toBeNull();
    await act(async () => mocks.webRtcConnected!());
    await render({ pages: [own(false), other(true)], anotherChatTurn: true, viewer: "webrtc" });
    expect(document.querySelector('[data-testid="shared-browser-webrtc"]')).toBeNull();
    expect(note()).toBe("Octo is working in another chat");
    await render({ pages: [own(), other()], viewer: "webrtc" });
    expect(document.querySelector('[data-testid="shared-browser-webrtc"]')).not.toBeNull();
  });

  it("lists only the chat's own tabs, and no list for one tab", async () => {
    await render({ pages: [own(), other()] });
    expect(document.querySelector('[data-testid="shared-browser-page-select"]')).toBeNull();
    expect(text()).not.toContain("frame.work");
    await render({ pages: [own(), other()], compact: true });
    expect(document.querySelector('[data-testid="shared-browser-tabs-picker"]')).toBeNull();
    expect(text()).not.toContain("frame.work");

    // With a tab of Octo's from the chat's turn, the list names the chat's two.
    const octoTab = { ...tab("PAGE-OCTO", "https://en.metrodoporto.pt/", true), openedBy: "agent" as const, agentTabNumber: 2 };
    await render({ pages: [own(false), other(), octoTab], chatPageIds: [CHAT_TAB, octoTab.id] });
    const options = Array.from(document.querySelectorAll<HTMLOptionElement>('[data-testid="shared-browser-page-select"] option'));
    expect(options.map((option) => option.value)).toEqual([CHAT_TAB, octoTab.id]);
    expect(text()).not.toContain("frame.work");
  });
});
