// @vitest-environment jsdom
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchStatus: vi.fn(), ensure: vi.fn(), stop: vi.fn(), stopIfIdle: vi.fn(), requestAccessToken: vi.fn(), clearForProject: vi.fn(), writeClipboardText: vi.fn(),
  fetchHost: vi.fn(), startHost: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: mocks.ensure, stop: mocks.stop, stopIfIdle: mocks.stopIfIdle },
  browserProfiles: { clearForProject: mocks.clearForProject },
  browserSessions: { fetchHost: mocks.fetchHost, startHost: mocks.startHost,
    isUnavailableError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
    isHostRefusedError: (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && !("status" in error)) },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken,
    requestAccessTokenResult: async (params: unknown) => {
      const token = await mocks.requestAccessToken(params);
      return token ? { ok: true, token } : { ok: false, error: { status: 0, message: "origin access request failed" } };
    } } },
} }));
vi.mock("../../../../runtime/runtimeMenuShared", () => ({ writeClipboardText: mocks.writeClipboardText }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
import { BrowserSessionModal, CLEAR_SHARED_BROWSER_HOST_DATA_BUSY_NOTE, CLEAR_SHARED_BROWSER_HOST_DATA_CONFIRMATION } from "../BrowserSessionModal";
import { BrowserLocationOptions } from "../PersonalBrowserSurface";
import { isBrowserRuntimeClaimActive } from "../../../../runtime/browserRuntimeClaimRegistry";
import { SHARED_BROWSER_HOST_COPY } from "../sharedBrowserHostAttach";
import { RUNTIME_DEBUG_STORAGE_KEY } from "../../../../runtime/utils/runtimeDebug";
import { useChatBrowserSessionState } from "../useChatBrowserSessionState";
import { useSharedBrowserResume } from "../useSharedBrowserResume";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secondId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const entry = (runtimeId: string) => ({ runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: `origin-${runtimeId}`, endpoint: "https://origin.test", protocols: ["http"] } });
const noop = () => {};

// Real routing + persisted browser state + production Modal, with only the
// controller network boundary substituted. Closing unmounts the Modal as ChatPanel does.
function RoutedSessionHarness({ onResolved }: { onResolved: (runtimeId: string | null) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useChatBrowserSessionState({ currentUserId: "user-1", activeProjectId: projectId, activeConversationId: "conversation-1",
    activeConversationControllerId: null, effectiveRuntimeId: null, preferredRuntimeId: null,
    refreshRuntimeStatuses: noop, setSessionRuntimeOverride: noop });
  const onReplaceSearch = useCallback((search: string) => navigate({ search }, { replace: true }), [navigate]);
  const resume = useSharedBrowserResume({ search: location.search, projectId, userId: "user-1",
    ready: state.browserSessionStateHydrated, onResume: state.resumeBrowserSession, onReplaceSearch });
  const { acknowledgeRuntimeResolved } = resume;
  const { handleBrowserRuntimeIdResolved } = state;
  const resolve = useCallback((runtimeId: string | null) => {
    acknowledgeRuntimeResolved(runtimeId);
    handleBrowserRuntimeIdResolved(runtimeId);
    onResolved(runtimeId);
  }, [acknowledgeRuntimeResolved, handleBrowserRuntimeIdResolved, onResolved]);
  return <>
    <output data-testid="resume-search">{location.search}</output>
    <button onClick={() => state.handleBrowserSessionOpenChange(false)}>Close test browser</button>
    <button onClick={state.handleToggleBrowserSession}>Reopen test browser</button>
    {state.browserSessionOpen ? <BrowserSessionModal isOpen onOpenChange={state.handleBrowserSessionOpenChange}
      projectId={projectId} currentUserId="user-1" preferRuntimeId={state.preferredBrowserRuntimeId}
      resumeRuntimeId={resume.runtimeId ?? state.exactBrowserRuntimeId} onRuntimeIdResolved={resolve}
      presentation="docked" fillContainer canControlBrowser sharedBrowserCapabilitiesResolved={false} /> : null}
  </>;
}

describe("production Shared modal resume selection", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onResolved = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.writeClipboardText.mockReset().mockResolvedValue(undefined);
    mocks.clearForProject.mockReset(); mocks.fetchStatus.mockReset(); mocks.ensure.mockReset(); mocks.requestAccessToken.mockReset(); onResolved.mockReset();
    window.sessionStorage.clear();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => { await act(async () => root.unmount()); await finishFocusRestoration(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  async function render(resumeRuntimeId: string | null, canControlBrowser = true, canClearBrowserData = false, transportActive = true) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={resumeRuntimeId} onRuntimeIdResolved={onResolved}
      presentation="docked" fillContainer transportActive={transportActive} canControlBrowser={canControlBrowser} canClearBrowserData={canClearBrowserData}
      sharedBrowserCapabilitiesResolved={false} />); });
  }
  async function finishFocusRestoration() {
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
  it("keeps session details and reset in options, dismisses with Escape and restores keyboard focus", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await render(firstId, true, true);
    expect(document.querySelector('[data-testid="shared-browser-current-runtime"]')).toBeNull();
    expect(document.querySelector('[data-testid="shared-browser-clear-data"]')).toBeNull();
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!;
    await act(async () => { trigger.focus(); trigger.click(); });
    expect(document.querySelector('[role="dialog"][aria-label="Browser options"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="shared-browser-current-runtime"]')?.closest("details")?.open).toBe(false);
    expect(document.querySelector('[data-testid="shared-browser-clear-data"]')?.textContent).toContain("Clear shared browser data");
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Close browser options"]')!.focus());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      document.activeElement!.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    await finishFocusRestoration();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("offers where the browser runs in Browser options, not in the toolbar", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    const onModeChange = vi.fn();
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={firstId} onRuntimeIdResolved={onResolved}
      presentation="docked" fillContainer transportActive canControlBrowser sharedBrowserCapabilitiesResolved={false}
      locationOptions={<BrowserLocationOptions checked mode="shared" personalAvailable onModeChange={onModeChange} />} />); });
    expect(document.querySelector('[data-testid="browser-transport-shared"]')).toBeNull();
    expect(document.querySelector('[data-testid="browser-location-menu"]')).toBeNull();
    // The toolbar keeps its room: no identity badge where the location menu was either.
    expect(document.querySelector('[data-testid="browser-identity-badge"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    const options = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Browser options"]')!;
    expect(options.querySelector('[role="group"][aria-label="Browser location"]')).not.toBeNull();
    expect(options.querySelector('[data-testid="browser-transport-shared"]')?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => options.querySelector<HTMLButtonElement>('[data-testid="browser-transport-personal"]')!.click());
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("personal");
  });

  it("dismisses a portalled options menu when its retained Browser view becomes hidden", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await render(firstId);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Browser options"]')).not.toBeNull();
    await render(firstId, true, false, false);
    expect(document.querySelector('[role="dialog"][aria-label="Browser options"]')).toBeNull();
    await render(firstId);
    expect(document.querySelector('[role="dialog"][aria-label="Browser options"]')).toBeNull();
  });

  it("does not open options when background session discovery completes after hiding Browser", async () => {
    let resolveStatus!: (value: { runtimes: ReturnType<typeof entry>[] }) => void;
    mocks.fetchStatus.mockReturnValue(new Promise(resolve => { resolveStatus = resolve; }));
    await render(null);
    await render(null, true, false, false);
    await act(async () => resolveStatus({ runtimes: [entry(firstId), entry(secondId)] }));
    expect(document.querySelector('[role="dialog"][aria-label="Browser options"]')).toBeNull();
    await render(null);
    expect(document.querySelector('[role="dialog"][aria-label="Browser options"]')).toBeNull();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("reveals and focuses the resume link when clipboard copying fails", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    mocks.writeClipboardText.mockRejectedValue(new Error("Clipboard unavailable"));
    await render(firstId);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    const link = document.querySelector<HTMLInputElement>('[aria-label="Shared Browser resume link"]')!;
    expect(link.closest("details")?.open).toBe(false);
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Copy resume link")!.click());
    expect(link.closest("details")?.open).toBe(true);
    expect(document.activeElement).toBe(link);
    expect(link.selectionStart).toBe(0);
    expect(link.selectionEnd).toBe(link.value.length);
    expect(document.body.textContent).toContain("Could not copy.");
  });
  it("closes options for a confirmed reset and prevents duplicate resets after reopening", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    let finishClear!: (result: { success: boolean }) => void;
    mocks.clearForProject.mockImplementation(() => new Promise(resolve => { finishClear = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render(firstId, true, true);
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!;
    await act(async () => trigger.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-clear-data"]')!.click());
    expect(mocks.clearForProject).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    await act(async () => trigger.click());
    expect(document.querySelector('[data-testid="shared-browser-clear-data"]')).toBeNull();
    await act(async () => finishClear({ success: false }));
    expect(document.querySelector('[data-testid="shared-browser-clear-data"]')).not.toBeNull();
    expect(mocks.clearForProject).toHaveBeenCalledTimes(1);
  });
  it("resolves an exact second session without ensuring a runtime", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId), entry(secondId)] });
    await render(secondId);
    expect(onResolved).toHaveBeenCalledWith(secondId);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    expect(document.body.textContent).toContain(secondId);
  });
  it.each([false, true])("distinguishes a failed capability lookup from an incompatible response (%s)", async (unsupported) => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await act(async () => root.render(<BrowserSessionModal isOpen onOpenChange={noop} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={firstId} presentation="docked" canControlBrowser
      sharedBrowserViewerKind={null} sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable={false}
      sharedBrowserCapabilitiesUnsupported={unsupported} />));
    if (unsupported) {
      expect(container.textContent).toContain("requires a newer version");
    } else {
      // A capability read that failed says the browser did not open; why is kept for runtime debug.
      expect(container.textContent).toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
      expect(container.querySelector("[data-debug-reason]")?.getAttribute("data-debug-reason")).toContain("Unable to connect to this browser session");
      expect(container.textContent).not.toContain("requires a newer version");
    }
  });
  it("does not allocate or silently join when the requested session is missing", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await render(secondId);
    expect(onResolved).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
    // The other session waits behind Browser options (⋯), which never opens by itself.
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="Resume Shared session ${firstId}"]`)!.click());
    expect(onResolved).toHaveBeenCalledWith(firstId); expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("announces compact opening progress and lets the participant expand the browser", async () => {
    vi.stubGlobal("innerHeight", 700);
    mocks.fetchStatus.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<BrowserSessionModal isOpen onOpenChange={noop} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} presentation="docked" canControlBrowser
      sharedBrowserCapabilitiesResolved={false} />));
    const card = container.querySelector('[data-testid="browser-session-collapsed-card"]')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(card.querySelector('[role="alert"]')).toBeNull();
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="Open browser fullscreen"]')!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Browser session"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="browser-session-collapsed-card"]')).toBeNull();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it.each([false, true])("lets compact recovery content determine the stage height (runtime limit: %s)", async limit => {
    // Inline recovery collapses below 760px; below 620px the whole viewer is fullscreen.
    vi.stubGlobal("innerHeight", 700);
    mocks.stop.mockClear();
    mocks.fetchStatus.mockResolvedValue({ runtimes: [] });
    const reason = limit
      ? Object.assign(new Error("Runtime limit reached"), { code: "runtime_limit_reached", details: {
        activeCount: 1, maxActiveCount: 1, blockerRuntimeId: secondId,
        blockerProjectLabel: "Another space with a very long name", blockerRuntimeLabel: "Long-running research machine",
      } })
      : new Error("provider 'test-cloud' is not configured on this controller");
    mocks.ensure.mockRejectedValue(reason);
    await act(async () => root.render(<BrowserSessionModal isOpen onOpenChange={noop} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} presentation="docked" canControlBrowser
      sharedBrowserCapabilitiesResolved={false} />));
    const stage = container.querySelector<HTMLElement>('[data-testid="browser-session-stage"]')!;
    expect(stage).not.toBeNull();
    expect(stage.style.height).toBe("");
    expect(stage.classList.contains("overflow-hidden")).toBe(false);
    expect(stage.querySelector('[data-testid="browser-session-collapsed-card"]')).not.toBeNull();
    if (limit) {
      expect(stage.textContent).toContain("Another space with a very long name");
      expect(stage.textContent).toContain("This can interrupt work running there.");
      expect(mocks.stop).not.toHaveBeenCalled();
    } else expect(stage.textContent).toContain("Browsing hasn't been set up for this workspace.");
  });
  it("requires a choice among multiple live sessions instead of taking the first", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId), entry(secondId)] });
    await render(null);
    expect(onResolved).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="browser-session-status"]')?.textContent).toBe("Choose session");
    // Opening the browser never opens Browser options by itself: the choice waits behind ⋯.
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    expect(document.querySelector('[data-testid="browser-session-state-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="browser-session-error-notice"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="Resume Shared session ${secondId}"]`)!.click());
    expect(onResolved).toHaveBeenCalledWith(secondId);
  });
  it("permits a view-only participant to resume but not create a browser", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await render(firstId, false); expect(onResolved).toHaveBeenCalledWith(firstId);
    await render(secondId, false);
    expect(document.body.textContent).not.toContain("Start new session"); expect(document.querySelector('[data-testid="shared-browser-clear-data"]')).toBeNull(); expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("does not turn failed discovery into a new allocation", async () => {
    mocks.fetchStatus.mockRejectedValue(new Error("offline"));
    await render(null); expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    expect(document.body.textContent).toContain("Instafy's browser did not open. Try again.");
  });

  it("explains missing browser setup and keeps the original failure for runtime debug", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [] });
    mocks.ensure.mockRejectedValue(new Error("provider 'test-cloud' is not configured on this controller"));
    await render(null);
    const notice = document.querySelector('[data-testid="browser-session-error-notice"]')!;
    expect(notice.textContent).toContain("Browsing hasn't been set up for this workspace.");
    expect(notice.textContent).toContain("Ask your administrator");
    // The raw reason is not on screen, only where runtime debug finds it.
    expect(notice.querySelector("details")).toBeNull();
    expect(notice.textContent).not.toContain("is not configured on this controller");
    expect(notice.querySelector("[data-debug-reason]")?.getAttribute("data-debug-reason"))
      .toBe("provider 'test-cloud' is not configured on this controller");
    window.localStorage.setItem(RUNTIME_DEBUG_STORAGE_KEY, "1");
    try {
      await render(null);
      const details = document.querySelector<HTMLDetailsElement>('[data-testid="browser-session-error-notice"] details')!;
      expect(details.open).toBe(false);
      expect(details.querySelector("summary")?.textContent).toBe("Technical details");
      expect(details.textContent).toContain("provider 'test-cloud' is not configured on this controller");
    } finally {
      window.localStorage.removeItem(RUNTIME_DEBUG_STORAGE_KEY);
    }
    const previousCalls = mocks.ensure.mock.calls.length;
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-session-error-retry"]')!.click());
    expect(mocks.ensure.mock.calls.length).toBeGreaterThan(previousCalls);
  });
  it("pins a resolved session through repeated retries even when another browser remains live", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await render(null);
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(firstId);
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(secondId)] });
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.getAttribute("aria-label") === "Refresh sessions")!.click());
    }
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("requested Shared session is not available");
  });
  it("ignores late discovery from a previous resume target", async () => {
    let resolvePrevious!: (value: { runtimes: ReturnType<typeof entry>[] }) => void;
    mocks.fetchStatus.mockImplementationOnce(() => new Promise((resolve) => { resolvePrevious = resolve; }));
    await render(firstId);
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(secondId)] });
    await render(secondId);
    await act(async () => resolvePrevious({ runtimes: [entry(firstId)] }));
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(secondId);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(firstId.slice(0, 8));
  });
  it.each(["chooser", "new session"])("keeps an explicit %s override after an incoming locator, close/reopen, and route reload", async (action) => {
    let runtimes = [entry(firstId), entry(secondId)];
    let selectedId = secondId;
    mocks.fetchStatus.mockImplementation(async () => ({ runtimes }));
    mocks.ensure.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      selectedId = runtimeId;
      runtimes = [...runtimes, entry(runtimeId)];
      return { runtimeId };
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const renderRoute = async (search: string, key: string) => act(async () => {
      root.render(<MemoryRouter key={key} initialEntries={[`/studio${search}`]}><RoutedSessionHarness onResolved={onResolved} /></MemoryRouter>);
    });
    await renderRoute(`?projectId=${projectId}&browserRuntimeId=${firstId}`, "initial");
    expect(onResolved).toHaveBeenLastCalledWith(firstId);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    if (action === "chooser") {
      await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="Resume Shared session ${secondId}"]`)!.click());
    } else {
      await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Start new session")!.click());
      expect(mocks.ensure).toHaveBeenCalledTimes(1);
    }
    expect(onResolved).toHaveBeenLastCalledWith(selectedId);
    const replacedSearch = document.querySelector('[data-testid="resume-search"]')!.textContent!;
    expect(new URLSearchParams(replacedSearch).get("browserRuntimeId")).toBe(selectedId);
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Close test browser")!.click());
    expect(document.querySelector('[data-testid="shared-browser-session-control"]')).toBeNull();
    onResolved.mockClear();
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Reopen test browser")!.click());
    expect(onResolved).toHaveBeenLastCalledWith(selectedId);
    expect(onResolved).not.toHaveBeenCalledWith(firstId);
    onResolved.mockClear();
    await renderRoute(replacedSearch, "reload");
    expect(onResolved).toHaveBeenLastCalledWith(selectedId);
    expect(onResolved).not.toHaveBeenCalledWith(firstId);
    expect(mocks.ensure).toHaveBeenCalledTimes(action === "new session" ? 1 : 0);
  });
});

/**
 * Instafy's browser on the space's own machine ("attach mode"): the machine
 * starts its browser on demand, so Studio never ensures, recycles or claims a
 * runtime for it, and Clear data restarts that same machine.
 */
describe("Shared modal attach mode", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onResolved = vi.fn();
  const ensureSpaceMachine = vi.fn<() => Promise<boolean>>();
  const hostId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const hostEntry = (overrides: Record<string, unknown> = {}) => ({ runtimeId: hostId, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime", health: "online",
    lastSeenAt: null, isLocal: false, origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] },
    sharedBrowserHost: { version: 1, mode: "lazy" }, ...overrides });
  const stoppedHost = () => hostEntry({ status: "stopped", health: "offline", origin: null, sharedBrowserHost: undefined });
  const covered = (...runtimes: unknown[]) => ({ runtimes, preferredRuntimeId: null, sharedBrowserHostPolicy: "covered" });
  const host = (state: string) => ({ version: 1, mode: "lazy", state, generation: null, failure: null, startedByYou: false,
    othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false });
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    for (const mock of Object.values(mocks)) mock.mockReset();
    onResolved.mockReset(); ensureSpaceMachine.mockReset().mockResolvedValue(true);
    mocks.fetchHost.mockResolvedValue(host("ready"));
    mocks.startHost.mockResolvedValue(host("starting"));
    window.sessionStorage.clear();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(options: { resumeRuntimeId?: string | null; canControlBrowser?: boolean; canClearBrowserData?: boolean;
    attachOnly?: boolean; spaceBusy?: boolean; conversationRuntimeId?: string | null; openedByPerson?: boolean;
    attachRequestToken?: number; onConnectionErrorChange?: (error: string | null) => void } = {}) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={options.resumeRuntimeId ?? null} onRuntimeIdResolved={onResolved}
      presentation="docked" fillContainer canControlBrowser={options.canControlBrowser ?? true} canClearBrowserData={options.canClearBrowserData ?? false}
      ensureSpaceMachine={ensureSpaceMachine} conversationRuntimeId={options.conversationRuntimeId ?? null}
      attachOnly={options.attachOnly ?? false} spaceBusy={options.spaceBusy ?? false} openedByPerson={options.openedByPerson ?? true}
      attachRequestToken={options.attachRequestToken ?? 0} onConnectionErrorChange={options.onConnectionErrorChange ?? null}
      sharedBrowserCapabilitiesResolved={false} />); });
  }
  const settle = (ms = 0) => act(async () => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const text = () => document.body.textContent ?? "";

  it("attaches to a live host without ensuring, stopping or claiming a runtime", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    await render();
    await settle();
    expect(onResolved).toHaveBeenCalledWith(hostId);
    expect(mocks.fetchHost).toHaveBeenCalledWith(expect.objectContaining({ projectId, runtimeId: hostId }));
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.stopIfIdle).not.toHaveBeenCalled();
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
  });

  it("claims from open, as before, and lets go once the first read shows the space's browser", async () => {
    let resolveStatus!: (value: unknown) => void;
    mocks.fetchStatus.mockReturnValueOnce(new Promise(resolve => { resolveStatus = resolve; }));
    await render();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(true);
    await act(async () => resolveStatus(covered(hostEntry())));
    await settle();
    expect(onResolved).toHaveBeenCalledWith(hostId);
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
  });

  it("still claims the runtime for a separate browser session", async () => {
    mocks.fetchStatus.mockResolvedValue({ ...covered(entry(firstId)) });
    await render({ resumeRuntimeId: firstId });
    expect(onResolved).toHaveBeenCalledWith(firstId);
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(true);
    await act(async () => root.unmount());
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
    root = createRoot(container);
  });

  it("starts an idle host for a builder and waits until it is ready", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.fetchHost.mockResolvedValueOnce(host("idle")).mockResolvedValueOnce(host("starting")).mockResolvedValue(host("ready"));
    await render();
    await settle(1_200);
    expect(mocks.startHost).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHost.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
  });

  it("polls a state it does not know instead of failing", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.fetchHost.mockResolvedValueOnce(host("unknown")).mockResolvedValue(host("ready"));
    await render();
    await settle(700);
    expect(mocks.fetchHost).toHaveBeenCalledTimes(2);
    expect(mocks.startHost).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="browser-session-error-notice"]')).toBeNull();
  });

  it("tells a viewer with an idle host to ask a builder, and never starts it", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.fetchHost.mockResolvedValue(host("idle"));
    await render({ canControlBrowser: false });
    await settle();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.askBuilder);
    expect(mocks.startHost).not.toHaveBeenCalled();
  });

  it("attaches again for a press while open: it reads the host again and starts it once it went idle", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    await render();
    await settle();
    expect(mocks.startHost).not.toHaveBeenCalled();
    const readsBefore = mocks.fetchHost.mock.calls.length;
    const statusBefore = mocks.fetchStatus.mock.calls.length;
    // The browser went idle after the last run.
    mocks.fetchHost.mockReset().mockResolvedValueOnce(host("idle")).mockResolvedValue(host("ready"));
    await render({ attachRequestToken: 1 });
    await settle(700);
    expect(mocks.fetchStatus.mock.calls.length).toBeGreaterThan(statusBefore);
    expect(mocks.fetchHost.mock.calls.length).toBeGreaterThan(0);
    expect(readsBefore).toBeGreaterThan(0);
    expect(mocks.startHost).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.didNotOpen);
    // The same token again is not a new press.
    const statusAfter = mocks.fetchStatus.mock.calls.length;
    await render({ attachRequestToken: 1 });
    await settle();
    expect(mocks.fetchStatus.mock.calls.length).toBe(statusAfter);
  });

  it("lets a press start the machine again in a browser Studio opened by itself", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(stoppedHost()));
    await render({ attachOnly: true, resumeRuntimeId: hostId });
    await settle();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    mocks.fetchStatus.mockReset()
      .mockResolvedValueOnce(covered(stoppedHost()))
      .mockResolvedValue(covered(hostEntry()));
    await render({ attachOnly: true, resumeRuntimeId: hostId, attachRequestToken: 1 });
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
  });

  it("tells the card the error it shows, and nothing once it closes", async () => {
    const onConnectionErrorChange = vi.fn();
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.fetchHost.mockResolvedValue(host("poisoned"));
    await render({ onConnectionErrorChange });
    await settle();
    expect(onConnectionErrorChange).toHaveBeenLastCalledWith(SHARED_BROWSER_HOST_COPY.poisoned);
    await act(async () => root.unmount());
    expect(onConnectionErrorChange).toHaveBeenLastCalledWith(null);
    root = createRoot(container);
  });

  it("says a poisoned host needs this space's machine to restart", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.fetchHost.mockResolvedValue(host("poisoned"));
    await render();
    await settle();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.poisoned);
    expect(mocks.startHost).not.toHaveBeenCalled();
  });

  it("hides Start new session and names the space's machine in the options", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    await render({ canClearBrowserData: true });
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await settle();
    expect(text()).not.toContain("Start new session");
    expect(text()).toContain("This space's machine");
    expect(document.querySelector('[data-testid="shared-browser-clear-data"]')).not.toBeNull();
  });

  it.each([false, true])("clears data by restarting the same machine (busy: %s)", async (spaceBusy) => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.clearForProject.mockResolvedValue({ success: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render({ canClearBrowserData: true, spaceBusy });
    await settle();
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    // The controller stopped the machine; once started again it reports its browser.
    mocks.fetchStatus.mockReset()
      .mockResolvedValueOnce(covered(stoppedHost()))
      .mockResolvedValue(covered(hostEntry()));
    onResolved.mockClear();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-clear-data"]')!.click());
    await settle();
    expect(confirm).toHaveBeenCalledWith(spaceBusy
      ? `${CLEAR_SHARED_BROWSER_HOST_DATA_CONFIRMATION} ${CLEAR_SHARED_BROWSER_HOST_DATA_BUSY_NOTE}`
      : CLEAR_SHARED_BROWSER_HOST_DATA_CONFIRMATION);
    expect(mocks.clearForProject).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith(hostId);
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
  });

  it("holds the claim while Clear data runs, so recovery cannot relaunch the machine mid-reset", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    let finishClear!: (result: { success: boolean }) => void;
    mocks.clearForProject.mockImplementation(() => new Promise(resolve => { finishClear = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render({ canClearBrowserData: true });
    await settle();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-clear-data"]')!.click());
    expect(mocks.clearForProject).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(true);
    mocks.fetchStatus.mockReset()
      .mockResolvedValueOnce(covered(stoppedHost()))
      .mockResolvedValue(covered(hostEntry()));
    await act(async () => finishClear({ success: true }));
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
  });

  it("restarts the machine after Clear data even in a browser Studio opened by itself", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    mocks.clearForProject.mockResolvedValue({ success: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render({ canClearBrowserData: true, attachOnly: true });
    await settle();
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-sessions-toggle"]')!.click());
    mocks.fetchStatus.mockReset()
      .mockResolvedValueOnce(covered(stoppedHost()))
      .mockResolvedValue(covered(hostEntry()));
    onResolved.mockClear();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-clear-data"]')!.click());
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(text()).not.toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
  });

  it.each([
    ["a pin to the stopped machine", true],
    ["nothing to open", false],
  ])("never wakes the space's machine for a restored open (%s) until the person presses Retry", async (_label, pinned) => {
    mocks.fetchStatus.mockResolvedValue(covered(...(pinned ? [stoppedHost()] : [])));
    await render({ openedByPerson: false, resumeRuntimeId: pinned ? hostId : null, conversationRuntimeId: hostId });
    await settle();
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
    mocks.fetchStatus.mockReset()
      .mockResolvedValueOnce(covered(...(pinned ? [stoppedHost()] : [])))
      .mockResolvedValue(covered(hostEntry()));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-session-error-retry"]')!.click());
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
  });

  it("lets the person's Retry start the machine in a browser Studio opened by itself", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(stoppedHost()));
    await render({ attachOnly: true, resumeRuntimeId: hostId });
    await settle();
    expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    mocks.fetchStatus.mockReset()
      .mockResolvedValueOnce(covered(stoppedHost()))
      .mockResolvedValue(covered(hostEntry()));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-session-error-retry"]')!.click());
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenLastCalledWith(hostId);
  });

  it("starts this space's machine for a press when nothing is running, then attaches", async () => {
    mocks.fetchStatus.mockResolvedValueOnce(covered()).mockResolvedValue(covered(hostEntry()));
    await render({ conversationRuntimeId: hostId });
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith(hostId);
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
  });

  it("restarts a stopped pinned machine instead of saying the session is missing", async () => {
    mocks.fetchStatus.mockResolvedValueOnce(covered(stoppedHost())).mockResolvedValue(covered(hostEntry()));
    await render({ resumeRuntimeId: hostId });
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("requested Shared session is not available");
    expect(onResolved).toHaveBeenCalledWith(hostId);
  });

  it("moves a stale pin to the space's live browser", async () => {
    mocks.fetchStatus.mockResolvedValue(covered(hostEntry()));
    await render({ resumeRuntimeId: secondId });
    await settle();
    expect(onResolved).toHaveBeenCalledWith(hostId);
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(text()).not.toContain("requested Shared session is not available");
  });

  it("falls back to the legacy browser at once when the machine comes up unattested", async () => {
    mocks.fetchStatus.mockResolvedValueOnce(covered())
      .mockResolvedValue(covered(hostEntry({ sharedBrowserHost: undefined })));
    mocks.ensure.mockResolvedValue({ runtimeId: secondId });
    const startedAt = Date.now();
    await render({ conversationRuntimeId: hostId });
    await settle();
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHost).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.each([covered(), covered(stoppedHost()), { runtimes: [], preferredRuntimeId: null }])(
    "never starts or ensures a machine for an open Studio started by itself",
    async (status) => {
      mocks.fetchStatus.mockResolvedValue(status);
      await render({ attachOnly: true, resumeRuntimeId: status.runtimes.length ? hostId : null });
      await settle();
      expect(ensureSpaceMachine).not.toHaveBeenCalled();
      expect(mocks.ensure).not.toHaveBeenCalled();
      expect(text()).toContain(SHARED_BROWSER_HOST_COPY.off);
    },
  );

  it("keeps today's flow when the controller sends no policy", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [hostEntry({ sharedBrowserHost: undefined })], preferredRuntimeId: null });
    await render({ canControlBrowser: false });
    await settle();
    expect(ensureSpaceMachine).not.toHaveBeenCalled();
    expect(mocks.fetchHost).not.toHaveBeenCalled();
    expect(text()).toContain("No Shared session is available. Ask a space builder to start one.");
  });
});
