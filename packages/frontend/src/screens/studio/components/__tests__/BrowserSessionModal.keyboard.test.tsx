// @vitest-environment jsdom
//
// A local test on a phone: a floating "Keyboard" button sat over the page in
// the Browser view. The touch keyboard's closed state is now an icon in the
// browser's own toolbar, and the keyboard puts it there itself: with no
// toolbar slot it shows no trigger at all, so the slot is checked here, in the
// real Browser view, for both of its toolbars.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpScreencastViewerProps } from "../CdpScreencastViewer";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(), requestAccessToken: vi.fn(), cdpCallbacks: null as CdpScreencastViewerProps | null,
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
vi.mock("../SharedBrowserDataClearAction", () => ({ SharedBrowserDataClearAction: () => null }));
vi.mock("../useSharedBrowserApproval", () => ({ useSharedBrowserApproval: () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: vi.fn() }) }));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
// The person holds the browser's control.
vi.mock("../useSharedBrowserCollaboration", () => ({ useSharedBrowserCollaboration: ({ active }: { active: boolean }) => ({
  client: { connectionStatus: active ? "connected" : "idle", participantId: active ? "self" : null,
    state: active ? { revision: 1, participants: [], requests: [], controlOwner: { kind: "human", participantId: "self" } } : null, error: null },
  publishCursor: () => {}, requestControl: () => {}, takeControl: () => {}, releaseControl: () => {}, grantControl: () => {},
}) }));
vi.mock("../CdpScreencastViewer", () => ({ CdpScreencastViewer: (props: CdpScreencastViewerProps) => {
  mocks.cdpCallbacks = props;
  return <canvas width={640} height={480} data-testid="shared-browser-cdp-screencast" />;
} }));
import { BrowserSessionModal } from "../BrowserSessionModal";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const noop = () => {};
const chrome = {
  pages: [{ id: "page-1", label: "Metro do Porto", title: "Metro do Porto", lastReferencedAt: 0, host: "metrodoporto.pt", url: "https://www.metrodoporto.pt/", isActive: true }],
  resolved: true, pendingAction: null, error: null,
  onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop,
};

describe("Browser view: the touch keyboard's trigger", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.cdpCallbacks = null;
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
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

  async function showLivePage(options: { inChat: boolean }) {
    await act(async () => root.render(<BrowserSessionModal isOpen transportActive onOpenChange={noop} projectId={projectId}
      currentUserId="user-1" browserSessionId="browser-session-1" preferRuntimeId={null} resumeRuntimeId={runtimeId}
      presentation="docked" fillContainer={options.inChat} canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
      sharedBrowserChrome={chrome} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await vi.dynamicImportSettled(); });
    expect(mocks.cdpCallbacks).not.toBeNull();
    await act(async () => mocks.cdpCallbacks!.onConnected());
  }

  const trigger = () => document.querySelector<HTMLElement>('[data-testid="shared-browser-mobile-keyboard-open"]');
  const viewport = () => document.querySelector('[data-testid="browser-session-viewport"]')!;

  it("is an icon in the chat's browser toolbar, never over the page", async () => {
    await showLivePage({ inChat: true });
    expect(trigger()).not.toBeNull();
    expect(trigger()!.closest('[data-testid="shared-browser-chrome"]')).not.toBeNull();
    expect(viewport().contains(trigger())).toBe(false);
    expect(trigger()!.getAttribute("aria-label")).toBe("Open remote keyboard");
    expect(trigger()!.textContent).toBe("");
    // Its input bar opens over the bottom of the page, which makes room for it.
    await act(async () => trigger()!.click());
    expect(viewport().querySelector('[data-testid="shared-browser-mobile-keyboard-input"]')).not.toBeNull();
  });

  it("is an icon in the browser's own toolbar outside a chat, never over the page", async () => {
    await showLivePage({ inChat: false });
    expect(trigger()).not.toBeNull();
    expect(viewport().contains(trigger())).toBe(false);
    expect(trigger()!.closest("[data-browser-session-safe-zone]")).not.toBeNull();
    expect(trigger()!.textContent).toBe("");
  });
});
