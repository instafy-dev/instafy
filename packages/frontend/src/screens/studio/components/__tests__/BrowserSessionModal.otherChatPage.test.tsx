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

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(), requestAccessToken: vi.fn(), webRtcConnected: null as null | (() => void),
  /** Who holds the browser's control: this person, or someone else. */
  owner: "self" as "self" | "other",
  /** The others in the browser, and the tab each one's view shows. */
  participants: [] as Array<{ id: string; displayName: string; color: string; pageId: string | null; cursor: null; canControl: boolean }>,
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
vi.mock("../useSharedBrowserApproval", () => ({ useSharedBrowserApproval: () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: vi.fn() }) }));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
vi.mock("../useSharedBrowserCollaboration", () => ({ useSharedBrowserCollaboration: ({ active }: { active: boolean }) => ({
  client: { connectionStatus: active ? "connected" : "idle", participantId: active ? "self" : null,
    state: active ? { revision: 1, participants: mocks.participants, requests: [],
      controlOwner: { kind: "human", participantId: mocks.owner } } : null, error: null },
  publishCursor: () => {}, requestControl: () => {}, takeControl: () => {}, releaseControl: () => {}, grantControl: () => {},
}) }));
// WebRTC sends the browser's whole screen, whatever tab is in front: while it
// is mounted, its stream is open.
vi.mock("../WebRtcBrowserViewer", () => ({ WebRtcBrowserViewer: (props: { onConnected: () => void; active: boolean }) => {
  mocks.webRtcConnected = props.onConnected;
  // A video that has drawn a picture, which a still can be taken from.
  const sized = (video: HTMLVideoElement | null) => {
    if (!video) return;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
  };
  return <video data-testid="shared-browser-webrtc" data-active={props.active ? "true" : "false"} ref={sized} />;
} }));
import { BrowserSessionModal, RECONNECTING_GRACE_MS } from "../BrowserSessionModal";

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
    mocks.owner = "self";
    mocks.participants = [];
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
    /** A browser turn of this chat on its way, to the site its card named. */
    arrivalSite?: string;
  }) {
    const viewer = options.viewer ?? "cdp-screencast";
    await act(async () => root.render(<BrowserSessionModal isOpen transportActive={options.shown ?? true}
      onOpenChange={noop} projectId={options.project ?? projectId} currentUserId="user-1"
      browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
      presentation="docked" fillContainer canControlBrowser canClearBrowserData sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind={viewer} sharedBrowserAvailableViewerKinds={[viewer]}
      conversationId="chat-lello" chatPageIds={options.chatPageIds ?? [CHAT_TAB]}
      anotherChatTurn={options.anotherChatTurn ?? false}
      agentArrival={options.arrivalSite ? { site: options.arrivalSite } : null}
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
  const webRtc = () => document.querySelector('[data-testid="shared-browser-webrtc"]');
  const still = () => document.querySelector('[data-testid="browser-session-frozen-frame"]');
  const reconnecting = () => document.querySelector('[data-testid="browser-session-reconnecting"]');
  /** The input socket this view has open, for the page it drives. */
  const inputSocket = () => FakeWebSocket.instances.filter((socket) =>
    socket.readyState === FakeWebSocket.OPEN && new URL(socket.url).pathname.endsWith("/browser/input")).at(-1) ?? null;

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

  // WebRTC sends the browser's whole screen, as RFB does: while someone else
  // in control shows another tab, its picture is that tab, whatever tab the
  // tab list names in front.
  it("connects no WebRTC picture while someone else in control shows another tab", async () => {
    mocks.owner = "other";
    mocks.participants = [{ id: "other", displayName: "Anna", color: "#2563eb", pageId: OTHER_TAB, cursor: null, canControl: true }];
    await render({ pages: [own(), other()], viewer: "webrtc" });
    expect(webRtc()).toBeNull();
    // Back on the chat's tab: its picture connects.
    mocks.participants = [{ ...mocks.participants[0]!, pageId: CHAT_TAB }];
    await render({ pages: [own(), other()], viewer: "webrtc" });
    expect(webRtc()).not.toBeNull();
  });

  // Behind Chat nobody can see whose tab is in front, so a whole-screen
  // picture is not kept there: a still of the chat's page stands in until
  // it is back.
  it("keeps no WebRTC picture behind Chat, and shows a still of the chat's page until it is back", async () => {
    await render({ pages: [own(), other()], viewer: "webrtc" });
    await act(async () => mocks.webRtcConnected!());
    await render({ pages: [own(), other()], viewer: "webrtc", shown: false });
    expect(webRtc()).toBeNull();
    await render({ pages: [own(), other()], viewer: "webrtc" });
    expect(webRtc()).not.toBeNull();
    expect(still()).not.toBeNull();
    await act(async () => mocks.webRtcConnected!());
    expect(still()).toBeNull();
  });

  // While a picture of the chat's page is on its way (here, of another of
  // its tabs) its surface is hidden: nothing typed or pressed reaches that
  // page until it shows.
  it("takes no input on a picture that is not on screen yet", async () => {
    const octoTab = (isActive: boolean) => ({ ...tab("PAGE-OCTO", "https://en.metrodoporto.pt/", isActive), openedBy: "agent" as const, agentTabNumber: 2 });
    const chatPageIds = [CHAT_TAB, "PAGE-OCTO"];
    await render({ pages: [own(), other(), octoTab(false)], chatPageIds });
    await drawFrame(pictures()[0]!.socket);
    expect(canvas()?.dataset.active).toBe("true");
    // The chat's turn reads in Octo's tab: its picture is on its way.
    await render({ pages: [own(false), other(), octoTab(true)], chatPageIds });
    expect(pictures().map((picture) => picture.pageId)).toEqual(["PAGE-OCTO"]);
    await act(async () => { inputSocket()!.emit({ type: "ready", width: 1280, height: 720, dpr: 1, deviceWidth: 1280, deviceHeight: 720 }); });
    expect(pictureShown()).toBe(false);
    expect(canvas()?.dataset.active).toBe("false");
    expect(document.querySelector('[data-active="true"][data-input-enabled="true"]')).toBeNull();
    const pressA = () => canvas()!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
    await act(async () => { pressA(); });
    expect(inputSocket()!.sent.filter((message) => JSON.parse(message).type === "key")).toEqual([]);
    // Its first frame: it shows, and takes input.
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(canvas()?.dataset.active).toBe("true");
    await act(async () => { pressA(); });
    expect(inputSocket()!.sent.filter((message) => JSON.parse(message).type === "key")).not.toEqual([]);
  });

  // The same for WebRTC: until the view has the chat's picture again, the
  // video takes no input.
  it("takes no input on a WebRTC picture that is not on screen yet", async () => {
    const octoTab = (isActive: boolean) => ({ ...tab("PAGE-OCTO", "https://en.metrodoporto.pt/", isActive), openedBy: "agent" as const, agentTabNumber: 2 });
    const chatPageIds = [CHAT_TAB, "PAGE-OCTO"];
    await render({ pages: [own(), other(), octoTab(false)], chatPageIds, viewer: "webrtc" });
    await act(async () => mocks.webRtcConnected!());
    expect(webRtc()?.getAttribute("data-active")).toBe("true");
    await render({ pages: [own(false), other(), octoTab(true)], chatPageIds, viewer: "webrtc" });
    expect(webRtc()?.getAttribute("data-active")).toBe("false");
    await act(async () => mocks.webRtcConnected!());
    expect(webRtc()?.getAttribute("data-active")).toBe("true");
  });

  // A view opened during another chat's turn has drawn nothing yet: when
  // the chat's page comes, it is opening, not reconnecting.
  it("says it is opening, never reconnecting, while the chat's first picture loads after another chat's turn", async () => {
    const reloaded = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await render({ pages: [own(false), other(true)], anotherChatTurn: true, project: reloaded });
    expect(note()).toBe("Octo is working in another chat");
    await render({ pages: [own(), other()], project: reloaded });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(reconnecting()).toBeNull();
    expect(text()).toContain("Opening Instafy's browser");
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(text()).not.toContain("Opening Instafy's browser");
  });

  /** The browser closes a picture's socket, as when the connection drops. */
  async function closeFromBrowser(socket: FakeWebSocket) {
    await act(async () => {
      socket.readyState = 3;
      for (const listener of socket.listeners.get("close") ?? []) {
        listener(Object.assign(new Event("close"), { code: 1006, reason: "" }));
      }
    });
  }

  // Local test, Oct 31: as another chat's turn ended, a chat's view said
  // "Reconnecting…" over its first picture since that turn, whose first frame
  // took 2 s: the space's browser had connected in this Studio before, so the
  // view counted itself as open. It had drawn no picture of the chat's page
  // since the turn, so there was nothing to reconnect: it is opening it.
  it("says it is opening, never reconnecting, while the chat's first picture after another chat's turn loads, in a browser that connected before", async () => {
    const space = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await render({ pages: [own(), other()], project: space });
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    await render({ pages: [own(false), other(true)], anotherChatTurn: true, project: space });
    expect(note()).toBe("Octo is working in another chat");
    // The turn ends and the chat's tab is in front: its picture's first frame
    // takes longer than the grace period.
    await render({ pages: [own(), other()], project: space });
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_GRACE_MS + 500); });
    expect(reconnecting()).toBeNull();
    expect(text()).toContain("Opening Instafy's browser");
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(text()).not.toContain("Opening Instafy's browser");
    // A picture of the chat's page it drew that goes is a reconnect.
    await closeFromBrowser(pictures()[0]!.socket);
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_GRACE_MS + 100); });
    expect(reconnecting()).not.toBeNull();
    expect(text()).not.toContain("Opening Instafy's browser");
  });

  // The same when the chat's own tab stayed in front through another chat's
  // turn (one that ended before it brought its own tab forward): the picture
  // the view closed for that turn is not one it holds.
  it("says it is opening, never reconnecting, after another chat's turn that left the chat's tab in front", async () => {
    const space = "abababab-abab-4bab-8bab-abababababab";
    await render({ pages: [own(), other()], project: space });
    await drawFrame(pictures()[0]!.socket);
    await render({ pages: [own(), other()], anotherChatTurn: true, project: space });
    expect(pictures()).toEqual([]);
    expect(note()).toBe("Octo is working in another chat");
    await render({ pages: [own(), other()], project: space });
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_GRACE_MS + 500); });
    expect(reconnecting()).toBeNull();
    expect(text()).toContain("Opening Instafy's browser");
    await drawFrame(pictures()[0]!.socket);
    expect(pictureShown()).toBe(true);
    expect(text()).not.toContain("Opening Instafy's browser");
  });

  // Review: when that first picture failed again and again, the stage stayed
  // blank with nothing said until the view gave up, 20 s later.
  it("says it is opening while the chat's first picture after another chat's turn keeps failing, until it gives up", async () => {
    const space = "12121212-1212-4212-8212-121212121212";
    await render({ pages: [own(), other()], project: space });
    await drawFrame(pictures()[0]!.socket);
    await render({ pages: [own(false), other(true)], anotherChatTurn: true, project: space });
    await render({ pages: [own(), other()], project: space });
    const said: string[] = [];
    for (let second = 1; second <= 25; second += 1) {
      // Every picture the view asks for closes before its first frame.
      for (const picture of pictures()) await closeFromBrowser(picture.socket);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      said.push(reconnecting() ? "reconnecting" : text().includes("Opening Instafy's browser") ? "opening"
        : document.querySelector('[data-testid="browser-session-error-notice"]') ? "error" : "nothing");
    }
    const gaveUp = said.indexOf("error");
    expect(gaveUp, said.join(" ")).toBeGreaterThan(1);
    // Within the grace period nothing; then that it is opening, up to the end.
    expect(said.slice(0, gaveUp), said.join(" ")).toEqual(["nothing", ...Array(gaveUp - 1).fill("opening")]);
  });

  // A still of the chat's page, kept from before another chat's turn, is a
  // picture the view drew: over it, the wait is a reconnect.
  it("says it is reconnecting over a still of the chat's page kept through another chat's turn", async () => {
    const space = "56565656-5656-4565-8565-565656565656";
    await render({ pages: [own(), other()], viewer: "webrtc", project: space });
    await act(async () => mocks.webRtcConnected!());
    await render({ pages: [own(), other()], viewer: "webrtc", shown: false, project: space });
    await render({ pages: [own(), other()], viewer: "webrtc", shown: false, anotherChatTurn: true, project: space });
    await render({ pages: [own(), other()], viewer: "webrtc", project: space });
    expect(still()).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_GRACE_MS + 500); });
    expect(reconnecting()).not.toBeNull();
    expect(text()).not.toContain("Opening Instafy's browser");
    await act(async () => mocks.webRtcConnected!());
    expect(still()).toBeNull();
    expect(reconnecting()).toBeNull();
  });

  // Over the blank tab a turn of the chat starts on, the stage already says
  // where Octo is going: one line, not that one and the opening line too.
  it("says only where Octo is going while the first picture of the blank tab a turn of the chat starts on loads", async () => {
    const space = "34343434-3434-4434-8434-343434343434";
    const blank = (isActive = true) => tab("PAGE-BLANK", "about:blank", isActive);
    const chatPageIds = [CHAT_TAB, "PAGE-BLANK"];
    await render({ pages: [own(), other(), blank(false)], chatPageIds, project: space });
    await drawFrame(pictures()[0]!.socket);
    await render({ pages: [own(false), other(), blank()], chatPageIds, project: space, arrivalSite: "visitporto.travel" });
    expect(pictures().map((picture) => picture.pageId)).toEqual(["PAGE-BLANK"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_GRACE_MS + 500); });
    expect(note()).toBe("Octo is opening visitporto.travel…");
    expect(reconnecting()).toBeNull();
    expect(text()).not.toContain("Opening Instafy's browser");
  });
});
