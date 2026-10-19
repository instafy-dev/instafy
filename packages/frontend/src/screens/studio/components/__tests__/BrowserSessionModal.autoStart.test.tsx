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
import { BROWSER_AUTO_START_COPY, type BrowserAutoStartPlan } from "../browserAutoStart";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const machineId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const machine = { runtimeId: machineId, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime", health: "online",
  isLocal: false, lastSeenAt: new Date().toISOString() };
const session = { runtimeId: sessionId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle",
  isLocal: false, lastSeenAt: null, origin: { originId: `origin-${sessionId}`, endpoint: "https://origin.test", protocols: ["http"] } };
const convert: Extract<BrowserAutoStartPlan, { kind: "convert" }> = {
  kind: "convert", runtimeId: machineId, projectId, provider: "instafy-cloud", displayName: "hosted runtime",
};

/**
 * Studio opens Instafy's browser by itself only where it is cheap: it reuses
 * a running session, or switches this space's own idle machine to the
 * browser. It never starts a second machine, recycles another one, or
 * presses Stop and open here on its own.
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
  async function render(plan: Extract<BrowserAutoStartPlan, { kind: "reuse" | "convert" }>) {
    await act(async () => { root.render(<BrowserSessionModal isOpen onOpenChange={vi.fn()} projectId={projectId}
      currentUserId="user-1" preferRuntimeId={null} resumeRuntimeId={null} onRuntimeIdResolved={onResolved}
      presentation="docked" fillContainer canControlBrowser sharedBrowserCapabilitiesResolved={false}
      autoStart={{ token: 1, plan }} onAutoStartFailure={onFailure} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("switches this space's idle machine to the browser: stop if idle, then the same runtime", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine] });
    mocks.stopIfIdle.mockResolvedValue({ statusChanged: true, skipReason: null });
    mocks.ensure.mockResolvedValue({ runtimeId: machineId });
    await render(convert);
    expect(mocks.stopIfIdle).toHaveBeenCalledExactlyOnceWith({
      runtimeId: machineId, reason: "runtime_limit_takeover", expectedProjectId: projectId,
      expectedProvider: "instafy-cloud", expectedDisplayName: "hosted runtime",
    });
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.ensure.mock.calls[0]![0]).toMatchObject({ projectId, runtimeId: machineId, displayName: "Browser session" });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("leaves a machine with live work alone and starts nothing", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine] });
    mocks.stopIfIdle.mockResolvedValue({ statusChanged: false, skipReason: "active_jobs" });
    await render(convert);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(1, BROWSER_AUTO_START_COPY.stillWorking);
  });

  it("never recycles another machine when the team's slot is taken elsewhere", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine] });
    mocks.stopIfIdle.mockResolvedValue({ statusChanged: true, skipReason: null });
    mocks.ensure.mockRejectedValue(Object.assign(new Error("Runtime limit reached"), {
      code: "runtime_limit_reached",
      details: { activeCount: 1, maxActiveCount: 1, blockerProjectId: "99999999-9999-4999-8999-999999999999",
        blockerRuntimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", blockerRuntimeLabel: "hosted runtime" },
    }));
    await render(convert);
    expect(mocks.stopIfIdle).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(1, BROWSER_AUTO_START_COPY.inUseElsewhere);
  });

  it("reuses the session already running and starts no machine", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine, session] });
    await render({ kind: "reuse" });
    expect(mocks.stopIfIdle).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith(sessionId);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not start a machine when the session it meant to reuse is gone", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [machine] });
    await render({ kind: "reuse" });
    expect(mocks.stopIfIdle).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(1, BROWSER_AUTO_START_COPY.secondMachine);
  });
});
