// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchStatus: vi.fn(), ensure: vi.fn(), stopIfIdle: vi.fn(), requestAccessToken: vi.fn(), clearForProject: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: mocks.ensure, stopIfIdle: mocks.stopIfIdle },
  browserProfiles: { clearForProject: mocks.clearForProject },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken } },
} }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
import { BrowserSessionModal } from "../BrowserSessionModal";
import { BROWSER_AUTO_START_COPY } from "../browserAutoStart";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const machineId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const machine = { runtimeId: machineId, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime", health: "online",
  isLocal: false, lastSeenAt: new Date().toISOString() };
const session = { runtimeId: sessionId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle",
  isLocal: false, lastSeenAt: null, origin: { originId: `origin-${sessionId}`, endpoint: "https://origin.test", protocols: ["http"] } };

/**
 * Studio opens Instafy's browser by itself only in a session already running
 * here. It never starts a machine, never stops or restarts this space's own
 * machine (whatever it still runs, such as a preview or a terminal, would
 * stop with it), never recycles another one and never presses Stop and open
 * here on its own.
 */
describe("Shared browser started by Studio itself", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onFailure = vi.fn();
  const onResolved = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    for (const mock of Object.values(mocks)) mock.mockReset();
    onFailure.mockReset(); onResolved.mockReset();
    window.sessionStorage.clear();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} onRuntimeIdResolved={onResolved}
      presentation="docked" fillContainer canControlBrowser sharedBrowserCapabilitiesResolved={false}
      autoStart={{ token: 1, runtimeId: sessionId }} onAutoStartFailure={onFailure} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it.each([
    ["an idle machine", { statusChanged: true, skipReason: null }],
    ["a machine with live work", { statusChanged: false, skipReason: "active_jobs" }],
  ])("never stops or restarts this space's own machine, %s", async (_name, stopOutcome) => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine] });
    mocks.stopIfIdle.mockResolvedValue(stopOutcome);
    mocks.ensure.mockResolvedValue({ runtimeId: machineId });
    await render();
    expect(mocks.stopIfIdle).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(1, BROWSER_AUTO_START_COPY.firstMachine);
  });

  it("reuses the session already running and starts no machine", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine, session] });
    await render();
    expect(mocks.stopIfIdle).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith(sessionId);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("never connects to another session that runs in its place", async () => {
    // The person's own session is gone and a teammate's runs: their pages and
    // sign-ins stay theirs.
    const teammates = { ...session, runtimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      origin: { ...session.origin, originId: "origin-teammate" } };
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine, teammates] });
    await render();
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(1, BROWSER_AUTO_START_COPY.otherSession);
  });

  it("does not start a machine when the session it meant to reuse is gone", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [] });
    await render();
    expect(mocks.stopIfIdle).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(1, BROWSER_AUTO_START_COPY.firstMachine);
  });
});
