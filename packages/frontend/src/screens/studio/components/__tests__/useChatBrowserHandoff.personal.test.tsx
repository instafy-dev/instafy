// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({ fetchStatus: vi.fn(), resolveRequestContext: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { core: { resolveRequestContext: controller.resolveRequestContext }, runtimes: { fetchStatus: controller.fetchStatus } },
}));
vi.mock("../../../../services/runtimeController/jobs", () => ({ cancelAgentJob: vi.fn() }));

import { useChatBrowserHandoff } from "../useChatBrowserHandoff";
import { usePersonalBrowserBridge } from "../usePersonalBrowserBridge";

type Personal = ReturnType<typeof usePersonalBrowserBridge>;
type Handoff = ReturnType<typeof useChatBrowserHandoff>;
type Options = Omit<Parameters<typeof useChatBrowserHandoff>[0], "personal">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function Harness({ value, resultRef }: { value: Options; resultRef: MutableRefObject<{ personal: Personal; handoff: Handoff } | null> }) {
  const personal = usePersonalBrowserBridge({
    active: value.open, profileUserId: value.userId, projectId: value.projectId,
    conversationBindingKey: value.conversationId,
  });
  resultRef.current = { personal, handoff: useChatBrowserHandoff({ ...value, personal }) };
  return null;
}

describe("Personal handoff with the real React browser bridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resultRef: MutableRefObject<{ personal: Personal; handoff: Handoff } | null>;
  let nativeStatus: InstafyDesktopPersonalBrowserStatus;
  let startup: ReturnType<typeof deferred<{ pid: number; runtimeId: string }>>;
  let value: Options;
  let setEnabled: ReturnType<typeof vi.fn<NonNullable<NonNullable<Window["instafyDesktop"]>["personalBrowserSetAgentControlEnabled"]>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resultRef = { current: null };
    startup = deferred();
    nativeStatus = { supported: true, enabled: true, state: "closed", visible: false, url: "https://example.test/form",
      canGoBack: false, canGoForward: false, agentControlEnabled: false, humanControlReady: true };
    controller.resolveRequestContext.mockResolvedValue({
      baseUrl: "https://controller.example.test", accessToken: "inert-test-token", credentialSource: "ambient", generation: 1,
    });
    controller.fetchStatus.mockResolvedValue({ runtimes: [{ runtimeId: "personal-fresh", status: "ready", health: "online" }] });
    setEnabled = vi.fn(async ({ enabled, ownerId }) => {
      expect(ownerId).toBe(nativeStatus.ownerId);
      nativeStatus = { ...nativeStatus, agentControlEnabled: enabled, humanControlReady: !enabled, runtimeId: undefined };
      return nativeStatus;
    });
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      personalBrowserStatus: vi.fn(async () => nativeStatus),
      personalBrowserSetBounds: vi.fn(async () => nativeStatus),
      personalBrowserOpen: vi.fn(async ({ ownerId, projectId }) => (nativeStatus = { ...nativeStatus, ownerId, projectId, state: "ready" })),
      personalBrowserRelease: vi.fn(async ({ ownerId }) => {
        if (nativeStatus.ownerId === ownerId) nativeStatus = { ...nativeStatus, ownerId: undefined, runtimeId: undefined, agentControlEnabled: false, humanControlReady: true };
        return nativeStatus;
      }),
      personalBrowserSetAgentControlEnabled: setEnabled,
      startDesktopRuntime: vi.fn(async () => {
        const result = await startup.promise;
        nativeStatus = { ...nativeStatus, runtimeId: result.runtimeId };
        return result;
      }),
    };
    value = {
      userId: "user-1", projectId: "project-1", conversationId: "conversation-1", transport: "personal",
      open: true, canWrite: true, runtimeId: null, page: null, runs: [], agentHandle: "octo",
      onSubmit: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.instafyDesktop;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  async function render(next = value) {
    await act(async () => root.render(<Harness value={next} resultRef={resultRef} />));
  }

  async function failFirstResume() {
    await render();
    expect(resultRef.current!.personal.ownerId).toBeTruthy();
    setEnabled.mockRejectedValueOnce(new Error("Native confirmation unavailable"));
    await act(async () => {
      expect(await resultRef.current!.handoff.continuePersonal("Continue", "ask")).toBe(false);
    });
    expect(resultRef.current!.personal.agentPhase).toBe("unavailable");
    expect(resultRef.current!.personal.status?.agentControlEnabled).toBe(false);
    expect(value.onSubmit).not.toHaveBeenCalled();
  }

  async function retry() {
    let pending!: Promise<boolean | Error>;
    let settled = false;
    await act(async () => {
      pending = resultRef.current!.handoff.continuePersonal("Continue", "ask")
        .catch((error: Error) => error).finally(() => { settled = true; });
    });
    return { pending, settled: () => settled };
  }

  it("opens a Chat task through native Ask control and dispatches only after the exact runtime is ready", async () => {
    await render();
    let pending!: Promise<boolean>;
    await act(async () => { pending = resultRef.current!.handoff.startPersonal("Continue comparing the saved items"); });
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true, approvalMode: "ask" }));
    expect(value.onSubmit).not.toHaveBeenCalled();
    await act(async () => startup.resolve({ pid: 42, runtimeId: "personal-fresh" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await pending).toBe(true);
    expect(value.onSubmit).toHaveBeenCalledWith("conversation-1", "Continue comparing the saved items", expect.objectContaining({
      runtimeOverride: expect.objectContaining({ runtimeId: "personal-fresh" }),
      metadata: expect.objectContaining({ browserTransport: "desktop-personal" }),
    }));
    await act(async () => { expect(await resultRef.current!.handoff.startPersonal("Inspect the cart")).toBe(true); });
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(value.onSubmit).toHaveBeenCalledTimes(2);
  });

  it("retries Done after a native failure without reading the pre-Resume unavailable phase as a new failure", async () => {
    await failFirstResume();
    const attempt = await retry();
    // Both production hooks are mounted: native Resume queues the bridge's
    // React state reset, but its promise resolves before that render commits.
    expect(attempt.settled()).toBe(false);
    expect(resultRef.current!.personal.agentPhase).toBe("starting");
    expect(value.onSubmit).not.toHaveBeenCalled();
    await act(async () => startup.resolve({ pid: 42, runtimeId: "personal-fresh" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await attempt.pending).toBe(true);
    expect(value.onSubmit).toHaveBeenCalledExactlyOnceWith("conversation-1", "Continue", expect.objectContaining({
      requireDispatch: true, runtimeOverride: expect.objectContaining({ runtimeId: "personal-fresh", preferRuntime: false }),
      metadata: expect.objectContaining({ browserTransport: "desktop-personal" }),
    }));
    expect(setEnabled.mock.calls.map(([call]) => call.enabled)).toEqual([true, true]);
  });

  it("still rejects a new startup failure after the prior error has cleared", async () => {
    await failFirstResume();
    const attempt = await retry();
    expect(attempt.settled()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => startup.reject(new Error("Fresh runtime failed")));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await attempt.pending).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("bounds a retry that never becomes ready without dispatch or fallback", async () => {
    await failFirstResume();
    const attempt = await retry();
    expect(attempt.settled()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900); });
    expect(attempt.settled()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await attempt.pending).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it.each(["conversation", "permission", "page"])("rejects a %s change while the retry's runtime is starting", async (change) => {
    await failFirstResume();
    const attempt = await retry();
    expect(attempt.settled()).toBe(false);
    if (change === "conversation") await render({ ...value, conversationId: "conversation-2" });
    if (change === "permission") await render({ ...value, canWrite: false });
    if (change === "page") {
      nativeStatus = { ...nativeStatus, url: "https://example.test/other-form" };
      await act(async () => startup.resolve({ pid: 42, runtimeId: "personal-fresh" }));
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await attempt.pending).toMatchObject({ message: expect.stringContaining("browser or conversation changed") });
    expect(value.onSubmit).not.toHaveBeenCalled();
    expect(setEnabled.mock.calls.map(([call]) => call.enabled)).toEqual([true, true]);
  });
});
