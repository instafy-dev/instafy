// @vitest-environment jsdom
//
// Local test, Oct 30: a chat's Browser view showed other chats' pages. It
// mounted on the address another chat left in front; during the chat's first
// browser turn its stage held another chat's picture under its own address,
// with "Reconnecting…", for 31 s; after a reload it showed the browser's
// first tab, another chat's page. A chat's view now shows only its own tabs.
//
// Local test, Oct 31: the blank stage still kept its viewer connected, so its
// hidden surface drew another chat's live page. While no tab of the chat is
// in front, or another chat's turn holds the browser, no viewer connects.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionPage } from "../browserSessionPages";

type Viewer = {
  canvas: HTMLCanvasElement;
  listeners: Record<string, () => void>;
  disconnect: ReturnType<typeof vi.fn>;
  viewOnly: boolean;
  _framebufferUpdate: () => boolean;
};
const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(), requestAccessToken: vi.fn(), instances: [] as Viewer[],
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
vi.mock("@novnc/novnc/lib/rfb", () => ({ default: class {
  canvas: HTMLCanvasElement;
  get _canvas() { return this.canvas; }
  background = "";
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
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const noop = () => {};

function tab(id: string, url: string, isActive: boolean): BrowserSessionPage {
  const host = new URL(url).host;
  return { id, url, host, label: host, title: host, lastReferencedAt: 0, isActive };
}
const CHAT_TAB = "PAGE-GITHUB";
const OTHER_TAB = "PAGE-PICO";
const GITHUB = "https://github.com/";
const PICO = "https://www.raspberrypi.com/products/raspberry-pi-pico-2/";

describe("a chat's Browser view", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.instances.length = 0;
    mocks.owner = "self";
    mocks.participants = [];
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
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
    chatPageIds?: string[] | null;
    anotherChatTurn?: boolean;
    active?: boolean;
    /** A browser turn of this chat on its way. */
    arriving?: boolean;
    /** A phone: one row of chrome. */
    compact?: boolean;
    onPresenceChange?: (presence: unknown) => void;
    /** RFB's view-only lane, for a person who does not drive. */
    viewOnlyLane?: boolean;
  }) {
    await act(async () => root.render(<BrowserSessionModal isOpen transportActive={options.active ?? true}
      onOpenChange={noop} projectId={projectId} currentUserId="user-1"
      browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
      presentation="docked" fillContainer canControlBrowser canClearBrowserData sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={["rfb"]}
      sharedBrowserRfbCapabilities={{ renderScale: 1, maxFramebufferPixels: 8_294_400, viewOnly: options.viewOnlyLane }}
      conversationId="chat-github"
      chatPageIds={options.chatPageIds === undefined ? [CHAT_TAB] : options.chatPageIds}
      anotherChatTurn={options.anotherChatTurn ?? false}
      agentArrival={options.arriving ? { site: null } : null}
      onPresenceChange={options.onPresenceChange}
      sharedBrowserChrome={{ pages: options.pages, resolved: true, pendingAction: null, error: null, compact: options.compact,
        onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await vi.dynamicImportSettled(); });
  }
  /** The viewer connected now: its canvas is on the page until it disconnects. */
  const viewer = () => mocks.instances.find((instance) => instance.canvas.isConnected) ?? null;
  async function paint() {
    const live = viewer()!;
    await act(async () => { live.listeners.connect(); live._framebufferUpdate(); });
  }
  /** The live picture: the surface the connected viewer draws in. */
  const surface = () => viewer()!.canvas.parentElement!;
  const pictureShown = () => viewer() !== null && !surface().classList.contains("invisible") &&
    !surface().classList.contains("opacity-0");
  const still = () => document.querySelector('[data-testid="browser-session-frozen-frame"]');
  /** What the address bar shows: on a narrow view, its button holds the address. */
  const address = () => document.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')?.value ??
    document.querySelector('[data-testid="shared-browser-address-trigger"]')!.textContent;
  const note = () => document.querySelector('[data-testid="browser-session-agent-arrival"]')?.textContent ?? null;

  it("draws the chat's own tab, and leaves the stage blank with no address and no viewer while another tab is in front", async () => {
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)] });
    await paint();
    expect(pictureShown()).toBe(true);
    expect(address()).toBe(GITHUB);
    expect(viewer()!.viewOnly).toBe(false);

    // Another chat's page comes to the front: nothing of it is drawn, not
    // even on a hidden surface, and the person's input cannot reach it.
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)] });
    expect(viewer()).toBeNull();
    expect(still()).toBeNull();
    expect(address()).not.toMatch(/https?:/);

    // The browser names no tab in front (after a reload): never its first
    // tab in its place.
    await render({ pages: [tab(OTHER_TAB, PICO, false), tab(CHAT_TAB, GITHUB, false)] });
    expect(viewer()).toBeNull();
    expect(address()).not.toMatch(/https?:/);

    // The chat's own tab in front again: its picture comes back.
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)] });
    expect(address()).toBe(GITHUB);
    await paint();
    expect(pictureShown()).toBe(true);
    expect(viewer()!.viewOnly).toBe(false);
  });

  it("shows the tab in front where a chat has no tabs of its own (an older browser)", async () => {
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)], chatPageIds: null });
    await paint();
    expect(pictureShown()).toBe(true);
    expect(address()).toBe(PICO);
  });

  it("shows nothing of another chat's turn, and says Octo is working in another chat", async () => {
    await render({ pages: [tab(CHAT_TAB, GITHUB, true)] });
    await paint();
    expect(note()).toBeNull();
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)], anotherChatTurn: true });
    expect(viewer()).toBeNull();
    expect(still()).toBeNull();
    expect(address()).not.toMatch(/https?:/);
    expect(note()).toBe("Octo is working in another chat");
    // Even while the chat's own tab is the one in front.
    await render({ pages: [tab(CHAT_TAB, GITHUB, true)], anotherChatTurn: true });
    expect(viewer()).toBeNull();
    expect(note()).toBe("Octo is working in another chat");
    await render({ pages: [tab(CHAT_TAB, GITHUB, true)] });
    await paint();
    expect(pictureShown()).toBe(true);
    expect(note()).toBeNull();
  });

  it("follows the chat's own turn into Octo's tabs, and says Octo is starting until the chat's page is in front", async () => {
    const octoTab = { ...tab("PAGE-OCTO", "https://www.metrodoporto.pt/", true), openedBy: "agent" as const, agentTabNumber: 2 };
    // Opened while another chat's page is in front: the view is open, with
    // no picture, and says where Octo is going.
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)], arriving: true });
    expect(viewer()).toBeNull();
    expect(note()).toBe("Octo is starting…");
    await render({ pages: [tab(CHAT_TAB, "about:blank", true), tab(OTHER_TAB, PICO, false)], arriving: true });
    await paint();
    expect(pictureShown()).toBe(true);
    expect(note()).toBe("Octo is starting…");
    // The turn reads in a tab of its own: the view follows it there.
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), octoTab], chatPageIds: [CHAT_TAB, octoTab.id], arriving: true });
    expect(pictureShown()).toBe(true);
    expect(note()).toBeNull();
    expect(address()).toBe("https://www.metrodoporto.pt/");
  });

  it("on a phone, shows nothing of another chat's page either", async () => {
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)], compact: true });
    expect(viewer()).toBeNull();
    expect(address()).not.toMatch(/https?:/);
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)], compact: true, anotherChatTurn: true });
    expect(viewer()).toBeNull();
    expect(note()).toBe("Octo is working in another chat");
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)], compact: true });
    await paint();
    expect(pictureShown()).toBe(true);
    expect(address()).toBe(GITHUB);
  });

  // Only the person who holds the browser's control may bring the chat's tab
  // to the front: after a reload the view's one try was refused while the
  // person's old session held it. Studio waits for this person to hold it.
  it("says whether this person holds the browser's control", async () => {
    const presence = vi.fn();
    await render({ pages: [tab(CHAT_TAB, GITHUB, true)], onPresenceChange: presence });
    expect(presence).toHaveBeenLastCalledWith(expect.objectContaining({ status: "known", selfControls: true }));
    mocks.owner = "other";
    await render({ pages: [tab(CHAT_TAB, GITHUB, true)], onPresenceChange: presence });
    expect(presence).toHaveBeenLastCalledWith(expect.objectContaining({ status: "known", selfControls: false }));
  });

  // The stage drew whatever was in front while the browser named no tab
  // there, under the chat's own address; on "Reconnecting…" that picture
  // stayed as the chat's page (another chat's) for 31 s. A picture of a tab
  // that is not the chat's is now never drawn, so none can be held.
  it("connects no viewer while no tab of the chat is named in front", async () => {
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, false)] });
    expect(mocks.instances).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await vi.dynamicImportSettled(); });
    expect(mocks.instances).toHaveLength(0);
    expect(still()).toBeNull();
    // Nor while another chat's tab is: back on the chat's tab, the stage
    // waits for the chat's own picture.
    await render({ pages: [tab(CHAT_TAB, GITHUB, false), tab(OTHER_TAB, PICO, true)] });
    expect(mocks.instances).toHaveLength(0);
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)] });
    expect(mocks.instances).toHaveLength(1);
    expect(pictureShown()).toBe(false);
    await paint();
    expect(pictureShown()).toBe(true);
  });

  it("keeps the chat's own picture on Reconnecting…", async () => {
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)] });
    await paint();
    const held = surface();
    expect(pictureShown()).toBe(true);
    await act(async () => viewer()!.listeners.disconnect());
    expect(held.classList.contains("invisible")).toBe(false);
  });

  // RFB draws whatever tab is in front. Someone else in control (another
  // person, or this person's other window) brought their own chat's tab
  // forward: this view drew it until its next read of the tab list.
  it("draws no picture of the tab someone else in control brought forward, before the tab list says so", async () => {
    mocks.owner = "other";
    mocks.participants = [{ id: "other", displayName: "Anna", color: "#2563eb", pageId: OTHER_TAB, cursor: null, canControl: true }];
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)], viewOnlyLane: true });
    // No picture of that tab is asked for, so none is kept as the chat's page.
    expect(viewer()).toBeNull();
    expect(still()).toBeNull();
    // Back on the chat's tab: its picture shows again.
    mocks.participants = [{ ...mocks.participants[0], pageId: CHAT_TAB }];
    await render({ pages: [tab(CHAT_TAB, GITHUB, true), tab(OTHER_TAB, PICO, false)], viewOnlyLane: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await vi.dynamicImportSettled(); });
    await paint();
    expect(pictureShown()).toBe(true);
  });
});
