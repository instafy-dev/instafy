// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";

const { cancelAgentJob, cancelConversationJobs, cancelPlanGroup } = vi.hoisted(() => ({
  cancelAgentJob: vi.fn(), cancelConversationJobs: vi.fn(), cancelPlanGroup: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/jobs", () => ({ cancelAgentJob, cancelConversationJobs, cancelPlanGroup }));

import { TAKE_OVER_KEEP_TAB_WAIT_MS, useChatBrowserHandoff } from "../useChatBrowserHandoff";

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

  it("takes over from a person's own tab while the browser reports the agent holds it", async () => {
    cancelAgentJob.mockResolvedValue({ ok: true, canceledJobIds: [JOB_ID], canceledRunIds: [] });
    // Octo closed its tab and the person's other tab is on screen.
    const onPersonsTab = options({ page: { id: "persons-tab", url: "https://example.test/form", host: "example.test", label: "Mine" } });
    await render(onPersonsTab);
    expect(resultRef.current!.sharedJob).toBeNull();
    expect(resultRef.current!.sharedJobWhileAgentHolds).toEqual({ jobId: JOB_ID, runId: RUN_ID });
    // Without the browser's word that the agent holds it, nothing is cancelled.
    await expect(resultRef.current!.takeOverShared()).resolves.toBe(false);
    expect(cancelAgentJob).not.toHaveBeenCalled();
    await expect(resultRef.current!.takeOverShared({ agentHoldsBrowser: true })).resolves.toBe(true);
    expect(cancelAgentJob).toHaveBeenCalledExactlyOnceWith(JOB_ID, "User taking over the browser");
  });

  it("keeps the agent's own tab on screen when the person takes over on it, then stops the turn", async () => {
    // Take over on a tab Octo opened: the turn's end closes Octo's tabs that
    // are not kept, so without this the page the person took would vanish.
    cancelAgentJob.mockResolvedValue({ ok: true, canceledJobIds: [JOB_ID], canceledRunIds: [] });
    const keepAgentTab = vi.fn().mockResolvedValue(true);
    const onOctosTab = { id: "octo-tab-1", url: "https://example.test/route", host: "example.test", label: "Route", openedBy: "agent" as const };
    await render(options({ page: onOctosTab, keepAgentTab }));
    await expect(resultRef.current!.takeOverShared({ agentHoldsBrowser: true })).resolves.toBe(true);
    expect(keepAgentTab).toHaveBeenCalledExactlyOnceWith("octo-tab-1");
    expect(cancelAgentJob).toHaveBeenCalledExactlyOnceWith(JOB_ID, "User taking over the browser");
    expect(keepAgentTab.mock.invocationCallOrder[0]).toBeLessThan(cancelAgentJob.mock.invocationCallOrder[0]);
  });

  it("keeps no tab for a person's own tab or a kept one, and stops the turn when keeping fails or hangs", async () => {
    cancelAgentJob.mockResolvedValue({ ok: true, canceledJobIds: [JOB_ID], canceledRunIds: [] });
    const keepAgentTab = vi.fn().mockResolvedValue(true);
    await render(options({ keepAgentTab }));
    await expect(resultRef.current!.takeOverShared({ agentHoldsBrowser: true })).resolves.toBe(true);
    const kept = { id: "octo-tab-1", url: "https://example.test/route", host: "example.test", label: "Route", openedBy: "agent" as const, kept: true };
    await render(options({ page: kept, keepAgentTab }));
    await expect(resultRef.current!.takeOverShared({ agentHoldsBrowser: true })).resolves.toBe(true);
    expect(keepAgentTab).not.toHaveBeenCalled();

    const octosTab = { ...kept, kept: false };
    await render(options({ page: octosTab, keepAgentTab: vi.fn().mockRejectedValue(new Error("gone")) }));
    await expect(resultRef.current!.takeOverShared({ agentHoldsBrowser: true })).resolves.toBe(true);
    const hanging = vi.fn(() => new Promise<boolean>(() => {}));
    await render(options({ page: octosTab, keepAgentTab: hanging }));
    const takingOver = resultRef.current!.takeOverShared({ agentHoldsBrowser: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(TAKE_OVER_KEEP_TAB_WAIT_MS); });
    await expect(takingOver).resolves.toBe(true);
    expect(hanging).toHaveBeenCalledOnce();
    expect(cancelAgentJob).toHaveBeenCalledTimes(4);
  });

  it("propagates cancellation failure without fallback", async () => {
    cancelAgentJob.mockRejectedValue(new Error("offline"));
    await render(options());
    await expect(resultRef.current!.takeOverShared()).rejects.toThrow("offline");
    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
  });

  it("names the browser run that Let AI continue continues, so the runtime can keep its approvals", async () => {
    const value = options();
    const base = value.runs[0];
    const stopped: RunRecord = {
      ...base, status: "canceled", updatedAt: "2026-10-27T10:58:45Z",
      metadata: { ...base.metadata, initiatingUserId: "user-1" },
    };
    const teammates: RunRecord = {
      ...stopped, id: "00000000-0000-4000-8000-000000000004", updatedAt: "2026-10-27T11:00:00Z",
      metadata: { ...stopped.metadata, initiatingUserId: "user-2" },
    };
    await render({ ...value, runs: [stopped, teammates] });
    await expect(resultRef.current!.continueSharedRun("Continue the previous browser task.")).resolves.toBe(true);
    expect(vi.mocked(value.onSubmit).mock.calls[0]![2]!.metadata).toMatchObject({
      browserContinuesRunId: RUN_ID, browserPageId: "page-1", browserRuntimeId: "shared-runtime-1",
    });
    // A card's task continues nothing: it starts with its own approvals.
    await resultRef.current!.continueShared("Open https://example.test/hours");
    expect(vi.mocked(value.onSubmit).mock.calls[1]![2]!.metadata).not.toHaveProperty("browserContinuesRunId");
    // With no run of the person's on this page to continue, none is named.
    await render({ ...value, runs: [teammates] });
    await resultRef.current!.continueSharedRun("Continue the previous browser task.");
    expect(vi.mocked(value.onSubmit).mock.calls[2]![2]!.metadata).not.toHaveProperty("browserContinuesRunId");
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

  // Local drive, Oct 29: a card's turn was bound to whatever tab was on
  // screen, another chat's Visit Lisboa page. It now runs in the chat's own
  // tab, whatever the browser shows meanwhile.
  it("runs a card's turn in the chat's own tab, not the page on screen", async () => {
    const value = options();
    await render(value);
    const tab = { id: "chat-tab-1", url: "about:blank", host: "", label: "New tab" };
    await expect(resultRef.current!.continueShared("Find the opening hours.", {
      display: "Opened Instafy's browser",
      metadata: { browserRequestOf: "job:job-1" },
    }, tab)).resolves.toBe(true);
    const sent = vi.mocked(value.onSubmit).mock.calls[0]![2]!;
    expect(sent.metadata).toMatchObject({ browserPageId: "chat-tab-1", browserPageUrl: "about:blank" });
    // Studio brings the chat's tab to the front while the turn is sent: the
    // page on screen changing does not stop it.
    await render({ ...value, page: { ...value.page!, id: "chat-tab-1", url: "about:blank" } });
    expect(() => sent.assertDispatchCurrent!()).not.toThrow();
    // Another chat or browser does.
    await render({ ...value, conversationId: "conversation-2" });
    expect(() => sent.assertDispatchCurrent!()).toThrow();
  });

  it("records a card's continuation as a notice and sends its task, with the card it continues", async () => {
    // Octo's request, not the person's words: the chat shows the notice, the
    // turn gets the task, and the prompt's metadata names the card.
    const value = options();
    await render(value);
    await expect(resultRef.current!.continueShared("Continue this browser task.\n\nOpen https://app.example.test", {
      display: "Octo opened Instafy's browser for app.example.test",
      metadata: { browserRequestOf: "job:job-1", browserAutoStarted: true, browserTransport: "desktop-personal" },
    })).resolves.toBe(true);
    expect(value.onSubmit).toHaveBeenCalledExactlyOnceWith("conversation-1", "Octo opened Instafy's browser for app.example.test", expect.objectContaining({
      dispatchInput: "Continue this browser task.\n\nOpen https://app.example.test",
      metadata: expect.objectContaining({
        browserRequestOf: "job:job-1", browserAutoStarted: true,
        // The card's metadata never overrides where the turn runs.
        browserTransport: "shared", browserRuntimeId: "shared-runtime-1", browserPageId: "page-1",
      }),
    }));
  });

  it("keeps the person's own approval mode when Octo opened its browser by itself", async () => {
    // Studio opening the browser grants nothing: the person's chosen mode
    // applies, exactly as for a press.
    const value = options({ transport: "personal", personal: personal({
      status: { ...personal().status!, approvalModes: ["ask", "routine"] },
      approvalModeChoice: "ask",
      preferredApprovalMode: "ask",
    } as Partial<Options["personal"]>) });
    await render(value);
    // Even an extras object that still says Studio opened it by itself.
    const extras = {
      display: "Octo opened Instafy's browser for app.example.test",
      metadata: { browserRequestOf: "job:job-1", browserAutoStarted: true },
      autoStarted: true,
    };
    void resultRef.current!.startPersonal("Open https://app.example.test", extras).catch(() => null);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(value.personal.setAgentControlEnabled).toHaveBeenCalledExactlyOnceWith(true, "ask");
  });

  it.each([
    // An owner-tier Desktop: routine, with the card's hosts.
    { policy: 2, preferred: "routine", automatic: true, expected: "routine", hosts: ["app.example.test"] },
    // An explicit Ask stays Ask, for Studio's own start as for a press.
    { policy: 2, preferred: "ask", automatic: true, expected: "ask", hosts: null },
    // An older Desktop's routine submits forms: Studio never asks for it by itself.
    { policy: undefined, preferred: "routine", automatic: true, expected: "ask", hosts: null },
    // A press keeps the person's choice on either host; hosts only go to the owner tier.
    { policy: undefined, preferred: "routine", automatic: false, expected: "routine", hosts: null },
    { policy: 2, preferred: "routine", automatic: false, expected: "routine", hosts: ["app.example.test"] },
    // Nothing chosen yet: routine only from an owner-tier Desktop.
    { policy: 2, preferred: null, automatic: true, expected: "routine", hosts: ["app.example.test"] },
    { policy: undefined, preferred: null, automatic: true, expected: "ask", hosts: null },
    { policy: undefined, preferred: null, automatic: false, expected: "ask", hosts: null },
  ] as const)("asks the Desktop for $expected (policy $policy, preference $preferred, automatic $automatic)", async ({ policy, preferred, automatic, expected, hosts }) => {
    const value = options({ transport: "personal", personal: personal({
      status: { ...personal().status!, approvalModes: ["ask", "routine"], ...(policy ? { approvalPolicyVersion: policy } : {}) },
      approvalModeChoice: preferred,
      // What the bridge resolves; the handoff reads the raw choice.
      preferredApprovalMode: preferred ?? (policy ? "routine" : "ask"),
    } as Partial<Options["personal"]>) });
    await render(value);
    void resultRef.current!.startPersonal("Open https://app.example.test", {
      display: "Octo opened Instafy's browser for app.example.test",
      metadata: { browserRequestOf: "job:job-1", ...(automatic ? { browserAutoStarted: true } : {}) },
      knownHosts: ["app.example.test"],
    }).catch(() => null);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(value.personal.setAgentControlEnabled).toHaveBeenCalledExactlyOnceWith(true, expected, ...(hosts ? [hosts] : []));
  });

  it("never records the card's hosts with the prompt", async () => {
    const override = { runtimeId: "personal-live", runtimeDisplayName: "Personal Browser", preferRuntime: false };
    const value = options({ transport: "personal", personal: personal({ runtimeOverride: override }) });
    await render(value);
    await expect(resultRef.current!.startPersonal("Open https://app.example.test", {
      metadata: { browserRequestOf: "job:job-1" }, knownHosts: ["app.example.test"],
    })).resolves.toBe(true);
    const sent = vi.mocked(value.onSubmit).mock.calls[0]![2]!;
    expect(JSON.stringify(sent.metadata)).not.toContain("knownHosts");
    // Control already running keeps its settings.
    expect(value.personal.setAgentControlEnabled).not.toHaveBeenCalled();
  });

  it.each([{ transport: "personal" as const }, { runtimeId: null }, { page: null }])("does not fall back when Shared routing is unavailable: %j", async (change) => {
    const value = options(change);
    await render(value);
    await expect(resultRef.current!.continueShared("Continue")).resolves.toBe(false);
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("does not bypass a pending manual-input step for a new browser request", async () => {
    const value = options({ transport: "personal", personal: personal({
      status: { ...personal().status!, humanInputRequest: {
        version: 1, handoffId: "manual-step", origin: "https://example.test",
        createdAtMs: 1000, expiresAtMs: 60000, fields: [{ label: "Password" }],
      } },
    }) });
    await render(value);
    await expect(resultRef.current!.startPersonal("Continue shopping")).rejects.toThrow("Finish the current manual step");
    expect(value.personal.setAgentControlEnabled).not.toHaveBeenCalled();
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps a card press blocked while a handoff is pending after the sign-in redirect cleared the request", async () => {
    // Desktop cleared humanInputRequest on navigation; the bridge's pending
    // handoff still holds the manual step.
    const value = options({ transport: "personal", personal: personal({
      pendingHandoff: { handoffId: "manual-step", expiresAtMs: 60000 },
    }) });
    await render(value);
    expect(value.personal.status?.humanInputRequest).toBeUndefined();
    await expect(resultRef.current!.startPersonal("Continue shopping")).rejects.toThrow(
      "Finish the current manual step and choose Let AI continue, or pause the browser, before starting another browser task.",
    );
    expect(value.personal.setAgentControlEnabled).not.toHaveBeenCalled();
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("checks a reused native runtime again at dispatch", async () => {
    const value = options({ transport: "personal", personal: personal({
      runtimeOverride: { runtimeId: "personal-live", runtimeDisplayName: "Personal Browser", preferRuntime: false },
    }) });
    await render(value);
    let check!: () => void;
    const dispatch = deferred<void>();
    vi.mocked(value.onSubmit).mockImplementation(async (_conversation, _message, opts) => {
      check = opts!.assertDispatchCurrent!;
      await dispatch.promise;
      check();
    });
    const pending = resultRef.current!.startPersonal("Inspect the current page").catch((error: Error) => error);
    expect(check).not.toThrow();
    await render({ ...value, personal: personal() });
    dispatch.resolve();
    expect(await pending).toMatchObject({ message: expect.stringContaining("Browser control changed") });
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

  it("does not dispatch when the new Personal runtime reports unavailable", async () => {
    const value = options({ transport: "personal" });
    await render(value);
    let pending!: Promise<unknown>;
    await act(async () => { pending = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error); });
    await render({ ...value, personal: { ...value.personal, agentPhase: "unavailable" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await pending).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.onSubmit).not.toHaveBeenCalled();
  });

  it("bounds a retry when the old unavailable phase never clears", async () => {
    const value = options({ transport: "personal", personal: personal({ agentPhase: "unavailable" }) });
    await render(value);
    let settled = false;
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = resultRef.current!.continuePersonal("Continue", "ask").catch((error) => error).finally(() => { settled = true; });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900); });
    expect(settled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(await pending).toMatchObject({ message: expect.stringContaining("not ready") });
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
