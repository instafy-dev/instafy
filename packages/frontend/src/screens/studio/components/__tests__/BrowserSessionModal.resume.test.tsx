// @vitest-environment jsdom
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchStatus: vi.fn(), ensure: vi.fn(), requestAccessToken: vi.fn(), clearForProject: vi.fn(), writeClipboardText: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: mocks.ensure },
  browserProfiles: { clearForProject: mocks.clearForProject },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken } },
} }));
vi.mock("../../../../runtime/runtimeMenuShared", () => ({ writeClipboardText: mocks.writeClipboardText }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
import { BrowserSessionModal } from "../BrowserSessionModal";
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
  async function render(resumeRuntimeId: string | null, canControlBrowser = true, canClearBrowserData = false) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={resumeRuntimeId} onRuntimeIdResolved={onResolved}
      presentation="docked" fillContainer canControlBrowser={canControlBrowser} canClearBrowserData={canClearBrowserData}
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
    expect(container.textContent).toContain(unsupported ? "requires a newer version" : "Unable to connect to this browser session");
    if (!unsupported) expect(container.textContent).not.toContain("requires a newer version");
  });
  it("does not allocate or silently join when the requested session is missing", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId)] });
    await render(secondId);
    expect(onResolved).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("requested Shared session is not available");
    await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="Resume Shared session ${firstId}"]`)!.click());
    expect(onResolved).toHaveBeenCalledWith(firstId); expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("requires a choice among multiple live sessions instead of taking the first", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [entry(firstId), entry(secondId)] });
    await render(null);
    expect(onResolved).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Several Shared sessions");
    expect(document.querySelector('[data-testid="browser-session-status"]')?.textContent).toBe("Choose session");
    expect(document.querySelector('[data-testid="browser-session-state-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="browser-session-error-notice"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent?.match(/Several Shared sessions/g)).toHaveLength(1);
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
    expect(document.body.textContent).toContain("no new browser was started");
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
