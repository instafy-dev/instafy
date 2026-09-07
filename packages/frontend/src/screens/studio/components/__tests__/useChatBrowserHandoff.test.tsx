// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";

const { cancelAgentJob, cancelConversationJobs, cancelPlanGroup } = vi.hoisted(() => ({
  cancelAgentJob: vi.fn(), cancelConversationJobs: vi.fn(), cancelPlanGroup: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/jobs", () => ({ cancelAgentJob, cancelConversationJobs, cancelPlanGroup }));

import { useChatBrowserHandoff } from "../useChatBrowserHandoff";

type Options = Parameters<typeof useChatBrowserHandoff>[0];
type Result = ReturnType<typeof useChatBrowserHandoff>;
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function personal(overrides: Partial<Options["personal"]> = {}): Options["personal"] {
  return {
    ownerId: "personal-owner-1", runtimeOverride: null, agentPhase: "idle",
    status: { ownerId: "personal-owner-1", state: "ready", agentControlEnabled: false, url: "https://example.test/form" },
    setAgentControlEnabled: vi.fn().mockResolvedValue({ agentControlEnabled: true }),
    ...overrides,
  } as Options["personal"];
}

function options(overrides: Partial<Options> = {}): Options {
  const run: RunRecord = {
    id: RUN_ID, projectId: "project-1", conversationId: "conversation-1", status: "in_progress",
    sessionId: null, promptId: null, runType: "prompt", progress: 0, progressStage: null,
    previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
    metadata: { jobId: JOB_ID, browserTransport: "shared", browserRuntimeId: "shared-runtime-1", browserPageId: "page-1" },
  };
  return {
    userId: "user-1", projectId: "project-1", conversationId: "conversation-1", transport: "shared",
    open: true, canWrite: true, runtimeId: "shared-runtime-1",
    page: { id: "page-1", url: "https://example.test/form", host: "example.test", label: "Form" },
    runs: [run], personal: personal(), agentHandle: "octo", onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function Harness({ value, resultRef }: { value: Options; resultRef: MutableRefObject<Result | null> }) {
  resultRef.current = useChatBrowserHandoff(value);
  return null;
}

describe("useChatBrowserHandoff", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resultRef: MutableRefObject<Result | null>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resultRef = { current: null };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    expect(cancelConversationJobs).not.toHaveBeenCalled();
    expect(cancelPlanGroup).not.toHaveBeenCalled();
  });
  async function render(value: Options) {
    await act(async () => root.render(<Harness value={value} resultRef={resultRef} />));
  }

  it("cancels exactly the identified Shared job, without conversation-wide fallback", async () => {
    cancelAgentJob.mockResolvedValue({ ok: true, canceledJobIds: [JOB_ID], canceledRunIds: [] });
    await render(options());
    await expect(resultRef.current!.takeOverShared()).resolves.toBe(true);
    expect(cancelAgentJob).toHaveBeenCalledExactlyOnceWith(JOB_ID, "User taking over the browser");
  });

  it.each([null, { ok: false, canceledJobIds: [], canceledRunIds: [] }, { ok: true, canceledJobIds: ["other-job"], canceledRunIds: ["other-run"] }])("does not treat an unrelated cancellation result as takeover: %j", async (response) => {
    cancelAgentJob.mockResolvedValue(response);
    await render(options());
    await expect(resultRef.current!.takeOverShared()).resolves.toBe(false);
    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not cancel anything when selection is ambiguous or Personal Browser is active", async () => {
    const original = options();
    await render({ ...original, runs: [original.runs[0], { ...original.runs[0], id: "another-run" }] });
    await expect(resultRef.current!.takeOverShared()).resolves.toBe(false);
    await render({ ...original, transport: "personal" });
    await expect(resultRef.current!.takeOverShared()).resolves.toBe(false);
    expect(cancelAgentJob).not.toHaveBeenCalled();
  });

  it("propagates cancellation failure without fallback", async () => {
    cancelAgentJob.mockRejectedValue(new Error("offline"));
    await render(options());
    await expect(resultRef.current!.takeOverShared()).rejects.toThrow("offline");
    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
  });

  it("dispatches Shared continuation directly with exact page/runtime and no draft attachments", async () => {
    const value = options();
    await render(value);
    await expect(resultRef.current!.continueShared("I filled the fields; continue.")).resolves.toBe(true);
    expect(value.onSubmit).toHaveBeenCalledExactlyOnceWith("conversation-1", "I filled the fields; continue.", {
      agentHandles: ["octo"], imageFiles: [], editorState: null, expectedLaneIdle: true,
      requireDispatch: true, assertDispatchCurrent: expect.any(Function),
      runtimeOverride: { runtimeId: "shared-runtime-1", runtimeDisplayName: null, preferRuntime: true },
      metadata: {
        browserTransport: "shared", browserConsentVersion: 1, browserRuntimeId: "shared-runtime-1",
        browserPageId: "page-1", browserPageUrl: "https://example.test/form", browserPageHost: "example.test", browserPageLabel: "Form",
        runtimeExpectations: { workspaceFileChanges: false, commandExecution: false, browserExecution: true },
      },
    });
    expect(cancelAgentJob).not.toHaveBeenCalled();
  });

  it.each([{ transport: "personal" as const }, { runtimeId: null }, { page: null }])("does not fall back when Shared routing is unavailable: %j", async (change) => {
    const value = options(change);
    await render(value);
    await expect(resultRef.current!.continueShared("Continue")).resolves.toBe(false);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("waits for a fresh Personal runtime with ready control before exact dispatch", async () => {
    const oldOverride = { runtimeId: "personal-old", runtimeDisplayName: "Personal Browser", preferRuntime: false };
    const value = options({ transport: "personal", personal: personal({ runtimeOverride: oldOverride }) });
    await render(value);
    let pending!: Promise<boolean>;
    await act(async () => { pending = resultRef.current!.continuePersonal("Continue", "routine"); });
    expect(value.personal.setAgentControlEnabled).toHaveBeenCalledExactlyOnceWith(true, "routine");
    expect(value.onSubmit).not.toHaveBeenCalled();
    const newOverride = { runtimeId: "personal-new", runtimeDisplayName: "Personal Browser", preferRuntime: false };
    const starting = { ...value, personal: { ...value.personal, runtimeOverride: newOverride, agentPhase: "starting" as const } };
    await render(starting);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(value.onSubmit).not.toHaveBeenCalled();
    await render({ ...starting, personal: { ...starting.personal, agentPhase: "ready", status: { ...starting.personal.status!, agentControlEnabled: true } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await expect(pending).resolves.toBe(true);
    expect(value.onSubmit).toHaveBeenCalledExactlyOnceWith("conversation-1", "Continue", {
      agentHandles: ["octo"], imageFiles: [], editorState: null, expectedLaneIdle: true,
      requireDispatch: true, assertDispatchCurrent: expect.any(Function),
      runtimeOverride: newOverride,
      metadata: { browserTransport: "desktop-personal", runtimeExpectations: { workspaceFileChanges: false, commandExecution: false, browserExecution: true } },
    });
  });

  it.each([
    ["account", (value: Options) => ({ ...value, userId: "user-2" })],
    ["project", (value: Options) => ({ ...value, projectId: "project-2" })],
    ["conversation", (value: Options) => ({ ...value, conversationId: "conversation-2" })],
    ["transport", (value: Options) => ({ ...value, transport: "shared" as const })],
    ["closed browser", (value: Options) => ({ ...value, open: false })],
    ["write access", (value: Options) => ({ ...value, canWrite: false })],
    ["owner", (value: Options) => ({ ...value, personal: { ...value.personal, ownerId: "owner-2" } })],
    ["same-origin page", (value: Options) => ({ ...value, personal: { ...value.personal, status: { ...value.personal.status!, url: "https://example.test/other-form" } } })],
  ] as const)("does not submit if %s changes while Personal resume awaits", async (_name, change) => {
    const resume = deferred<Awaited<ReturnType<Options["personal"]["setAgentControlEnabled"]>>>();
    const value = options({ transport: "personal", personal: personal({ setAgentControlEnabled: vi.fn().mockReturnValue(resume.promise) }) });
    await render(value);
    let pending!: Promise<unknown>;
    await act(async () => { pending = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error); });
    await render(change(value));
    await act(async () => { resume.resolve({ agentControlEnabled: true } as Awaited<typeof resume.promise>); });
    expect(await pending).toBeInstanceOf(Error);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ["account", (value: Options) => ({ ...value, userId: "user-2" })],
    ["page URL", (value: Options) => ({ ...value, personal: { ...value.personal, status: { ...value.personal.status!, url: "https://example.test/other-form" } } })],
    ["write permission", (value: Options) => ({ ...value, canWrite: false })],
  ] as const)("rejects %s ABA changes during an awaited resume", async (_label, change) => {
    const resume = deferred<Awaited<ReturnType<Options["personal"]["setAgentControlEnabled"]>>>();
    const value = options({ transport: "personal", personal: personal({ setAgentControlEnabled: vi.fn().mockReturnValue(resume.promise) }) });
    await render(value);
    let pending!: Promise<unknown>;
    await act(async () => { pending = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error); });
    await render(change(value));
    await render(value);
    await act(async () => { resume.resolve({ agentControlEnabled: true } as Awaited<typeof resume.promise>); });
    expect(await pending).toBeInstanceOf(Error);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("fences a page change during Personal runtime startup, after enablement resolved", async () => {
    const value = options({ transport: "personal" });
    await render(value);
    let pending!: Promise<unknown>;
    await act(async () => { pending = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error); });
    expect(value.personal.setAgentControlEnabled).toHaveBeenCalledTimes(1);
    await render({ ...value, personal: { ...value.personal, status: { ...value.personal.status!, url: "https://example.test/another-form" } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await pending).toBeInstanceOf(Error);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("rejects page navigation while exact Shared cancellation awaits", async () => {
    const cancellation = deferred<unknown>();
    cancelAgentJob.mockReturnValue(cancellation.promise);
    const value = options();
    await render(value);
    const pending = resultRef.current!.takeOverShared().catch((error) => error);
    await render({ ...value, page: { ...value.page!, url: "https://example.test/other-form" } });
    cancellation.resolve({ ok: true, canceledJobIds: [JOB_ID], canceledRunIds: [] });
    expect(await pending).toBeInstanceOf(Error);
    expect(cancelAgentJob).toHaveBeenCalledExactlyOnceWith(JOB_ID, "User taking over the browser");
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("times out missing Personal readiness without any fallback submit", async () => {
    const value = options({ transport: "personal" });
    await render(value);
    let pending!: Promise<unknown>;
    await act(async () => { pending = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error); });
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(await pending).toBeInstanceOf(Error);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("does not dispatch when the Personal runtime reports unavailable", async () => {
    const value = options({ transport: "personal", personal: personal({ agentPhase: "unavailable" }) });
    await render(value);
    await expect(resultRef.current!.continuePersonal("Continue", "ask")).rejects.toThrow(/not ready/);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it.each([{ userId: null }, { projectId: null }, { conversationId: null }, { open: false }, { canWrite: false }])("rejects missing identity/authority before side effects: %j", async (change) => {
    const value = options(change);
    await render(value);
    await expect(resultRef.current!.takeOverShared()).rejects.toThrow();
    await expect(resultRef.current!.continueShared("Continue")).rejects.toThrow();
    await expect(resultRef.current!.continuePersonal("Continue", "ask")).rejects.toThrow();
    expect(cancelAgentJob).not.toHaveBeenCalled();
    expect(value.personal.setAgentControlEnabled).not.toHaveBeenCalled();
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("does not retry Shared submit failures through another runtime", async () => {
    const value = options({ onSubmit: vi.fn().mockRejectedValue(new Error("runtime disappeared")) });
    await render(value);
    await expect(resultRef.current!.continueShared("Continue")).rejects.toThrow("runtime disappeared");
    expect(value.onSubmit).toHaveBeenCalledTimes(1);
    expect(value.personal.setAgentControlEnabled).not.toHaveBeenCalled();
  });

  it("rechecks the Shared captured page when submission preflight is ready to send", async () => {
    const value = options();
    await render(value);
    await resultRef.current!.continueShared("Continue");
    const request = vi.mocked(value.onSubmit).mock.calls[0][2]!;
    expect(request.requireDispatch).toBe(true);
    expect(() => request.assertDispatchCurrent!()).not.toThrow();
    await render({ ...value, page: { ...value.page!, url: "https://example.test/different" } });
    expect(() => request.assertDispatchCurrent!()).toThrow("browser or conversation changed");
  });

  it.each(["unchanged", "account", "owner", "runtime", "page", "permission"])("rolls back failed Personal dispatch only for its exact resumed scope: %s", async (change) => {
    const submitted = deferred<void>();
    const setEnabled = vi.fn().mockResolvedValue({ agentControlEnabled: true, runtimeId: "personal-new" });
    const value = options({
      transport: "personal", onSubmit: vi.fn().mockReturnValue(submitted.promise),
      personal: personal({ setAgentControlEnabled: setEnabled }),
    });
    await render(value);
    let result!: Promise<unknown>;
    await act(async () => { result = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error); });
    const ready: Options = { ...value, personal: { ...value.personal, agentPhase: "ready",
      status: { ...value.personal.status!, runtimeId: "personal-new", agentControlEnabled: true },
      runtimeOverride: { runtimeId: "personal-new", runtimeDisplayName: "Personal Browser", preferRuntime: false },
    } };
    await render(ready);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(value.onSubmit).toHaveBeenCalledTimes(1);
    const dispatch = vi.mocked(value.onSubmit).mock.calls[0][2]!;
    expect(() => dispatch.assertDispatchCurrent!()).not.toThrow();
    if (change === "account") await render({ ...ready, userId: "user-2" });
    if (change === "owner") await render({ ...ready, personal: { ...ready.personal, ownerId: "owner-2" } });
    if (change === "runtime") await render({ ...ready, personal: { ...ready.personal,
      status: { ...ready.personal.status!, runtimeId: "replacement-runtime" },
      runtimeOverride: { ...ready.personal.runtimeOverride!, runtimeId: "replacement-runtime" },
    } });
    if (change === "page") await render({ ...ready, personal: { ...ready.personal, status: { ...ready.personal.status!, url: "https://example.test/another" } } });
    if (change === "permission") await render({ ...ready, canWrite: false });
    if (change !== "unchanged") expect(() => dispatch.assertDispatchCurrent!()).toThrow();
    await act(async () => { submitted.reject(new Error("controller lane unavailable")); });
    expect(await result).toMatchObject({ message: "controller lane unavailable" });
    expect(setEnabled.mock.calls).toEqual(change === "unchanged" ? [[true, "ask"], [false]] : [[true, "ask"]]);
  });

  it("does not submit if Personal enablement fails or returns disabled", async () => {
    for (const failure of [false, true]) {
      const enable = failure ? vi.fn().mockRejectedValue(new Error("native unavailable")) : vi.fn().mockResolvedValue({ agentControlEnabled: false });
      const value = options({ transport: "personal", personal: personal({ setAgentControlEnabled: enable }) });
      await render(value);
      const result = await resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error);
      expect(failure ? result instanceof Error : result === false).toBe(true);
      expect(value.onSubmit).not.toHaveBeenCalled();
    }
  });
});
