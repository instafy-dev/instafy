import { useCallback, useEffect, useRef } from "react";
import type { SubmitConversationOptions } from "../../../conversations/useConversation";
import { cancelAgentJob } from "../../../services/runtimeController/jobs";
import type { RunRecord } from "../../../types";
import { sharedBrowserTakeoverJob } from "./browserHandoffRouting";
import type { BrowserSessionPageTarget } from "./browserSessionPages";
import { buildSharedBrowserSubmitMetadata, withPersonalBrowserRuntimeExpectations } from "./sharedBrowserSubmitRouting";
import type { BrowserTransport, usePersonalBrowserBridge } from "./usePersonalBrowserBridge";

type Options = {
  userId: string | null;
  projectId: string | null;
  conversationId: string | null;
  transport: BrowserTransport;
  open: boolean;
  canWrite: boolean;
  runtimeId: string | null;
  page: BrowserSessionPageTarget | null;
  runs: RunRecord[];
  personal: ReturnType<typeof usePersonalBrowserBridge>;
  agentHandle: string;
  onSubmit: (id: string | null, message: string, options?: SubmitConversationOptions) => Promise<void>;
};

function identity(value: Options) {
  return JSON.stringify([
    value.userId, value.projectId, value.conversationId, value.transport, value.open,
    value.transport === "shared" ? value.runtimeId : value.personal.ownerId,
    value.transport === "shared" ? value.page?.id : null,
  ]);
}

function pageUrl(value: Options) {
  return value.transport === "shared" ? value.page?.url : value.personal.status?.url;
}

export function useChatBrowserHandoff(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const identityKey = identity(options);
  const operationIdentityKey = JSON.stringify([identityKey, pageUrl(options), options.canWrite]);
  const lastIdentity = useRef(operationIdentityKey);
  const generation = useRef(0);
  if (lastIdentity.current !== operationIdentityKey) {
    lastIdentity.current = operationIdentityKey;
    generation.current += 1;
  }
  const assertCurrent = useCallback((captured: Options, epoch: number) => {
    if (!mounted.current || generation.current !== epoch || !latest.current.canWrite || !latest.current.open || !captured.userId || !captured.projectId || !captured.conversationId || identity(latest.current) !== identity(captured) || pageUrl(latest.current) !== pageUrl(captured)) {
      throw new Error("The browser or conversation changed. Return to the intended page before continuing.");
    }
  }, []);
  const sharedJob = sharedBrowserTakeoverJob(options.runs, options.runtimeId, options.page?.id ?? null);

  const takeOverShared = useCallback(async () => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "shared") return false;
    const job = sharedBrowserTakeoverJob(captured.runs, captured.runtimeId, captured.page?.id ?? null);
    if (!job) return false;
    const result = await cancelAgentJob(job.jobId, "User taking over the browser");
    assertCurrent(captured, epoch);
    // This acknowledges the cancellation request only. The surface separately
    // waits for origin-confirmed human ownership before enabling manual input.
    return result?.ok === true && (result.canceledJobIds.includes(job.jobId) || result.canceledRunIds.includes(job.runId));
  }, [assertCurrent]);

  const continueShared = useCallback(async (message: string) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "shared" || !captured.runtimeId || !captured.page) return false;
    await captured.onSubmit(captured.conversationId, message, {
      agentHandles: [captured.agentHandle],
      imageFiles: [],
      editorState: null,
      expectedLaneIdle: true,
      requireDispatch: true,
      assertDispatchCurrent: () => assertCurrent(captured, epoch),
      runtimeOverride: { runtimeId: captured.runtimeId, runtimeDisplayName: null, preferRuntime: true },
      metadata: buildSharedBrowserSubmitMetadata({ baseMetadata: null, browserPageTarget: captured.page, runtimeId: captured.runtimeId }),
    });
    return true;
  }, [assertCurrent]);

  const continuePersonal = useCallback(async (message: string, approvalMode: "ask" | "routine") => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "personal") return false;
    const previousRuntimeId = captured.personal.runtimeOverride?.runtimeId ?? captured.personal.status?.runtimeId;
    let resumedRuntimeId: string | null = null;
    try {
      const resumed = await captured.personal.setAgentControlEnabled(true, approvalMode);
      resumedRuntimeId = resumed?.runtimeId ?? null;
      assertCurrent(captured, epoch);
      if (!resumed?.agentControlEnabled) return false;
      const deadline = Date.now() + 30_000;
      // Resume queues the bridge's React state reset before its promise resolves.
      // A retry must not mistake the still-rendered prior error for a new startup
      // failure. Once the reset is observed, later failures remain fail-fast; if
      // React skips that transition entirely, the bounded deadline still applies.
      let awaitingRetryReset = captured.personal.agentPhase === "unavailable";
      // Runtime startup is asynchronous and allocates a new exact ID. Never send
      // through the revoked pre-takeover runtime or fall back to Shared Browser.
      while (!latest.current.personal.runtimeOverride?.runtimeId ||
        latest.current.personal.runtimeOverride?.runtimeId === previousRuntimeId ||
        latest.current.personal.status?.agentControlEnabled !== true ||
        latest.current.personal.agentPhase !== "ready") {
        assertCurrent(captured, epoch);
        const phase = latest.current.personal.agentPhase;
        if (phase !== "unavailable") awaitingRetryReset = false;
        if (Date.now() >= deadline || (!awaitingRetryReset && phase === "unavailable")) {
          throw new Error("Personal Browser control is not ready. Your input remains on the page; retry when ready.");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      assertCurrent(captured, epoch);
      const runtimeOverride = latest.current.personal.runtimeOverride!;
      resumedRuntimeId = runtimeOverride.runtimeId;
      const assertDispatchCurrent = () => {
        assertCurrent(captured, epoch);
        if (latest.current.personal.runtimeOverride?.runtimeId !== resumedRuntimeId ||
          latest.current.personal.status?.agentControlEnabled !== true ||
          latest.current.personal.agentPhase !== "ready") {
          throw new Error("Personal Browser control changed before the task was sent. Take control again before continuing.");
        }
      };
      await captured.onSubmit(captured.conversationId, message, {
        agentHandles: [captured.agentHandle],
        imageFiles: [],
        editorState: null,
        expectedLaneIdle: true,
        requireDispatch: true,
        assertDispatchCurrent,
        runtimeOverride,
        metadata: withPersonalBrowserRuntimeExpectations({ browserTransport: "desktop-personal" }),
      });
      return true;
    } catch (error) {
      // A failed continuation must not leave its freshly resumed page locked.
      // Never revoke a replacement account, page, owner or native runtime.
      const current = latest.current;
      if (mounted.current && generation.current === epoch && identity(current) === identity(captured) &&
        pageUrl(current) === pageUrl(captured) && resumedRuntimeId &&
        current.personal.status?.runtimeId === resumedRuntimeId &&
        (!current.personal.runtimeOverride || current.personal.runtimeOverride.runtimeId === resumedRuntimeId) &&
        current.personal.status.agentControlEnabled) {
        await current.personal.setAgentControlEnabled(false).catch(() => null);
      }
      throw error;
    }
  }, [assertCurrent]);

  const startPersonal = useCallback(async (message: string) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "personal") return false;
    if (captured.personal.status?.humanInputRequest) {
      throw new Error("Finish the current manual step and choose Done, continue before starting another browser task.");
    }
    const runtimeOverride = captured.personal.runtimeOverride;
    if (!runtimeOverride) return continuePersonal(message, "ask");
    await captured.onSubmit(captured.conversationId, message, {
      agentHandles: [captured.agentHandle],
      imageFiles: [],
      editorState: null,
      expectedLaneIdle: true,
      requireDispatch: true,
      assertDispatchCurrent: () => {
        assertCurrent(captured, epoch);
        if (latest.current.personal.runtimeOverride?.runtimeId !== runtimeOverride.runtimeId) {
          throw new Error("Browser control changed before the task was sent.");
        }
      },
      runtimeOverride,
      metadata: withPersonalBrowserRuntimeExpectations({ browserTransport: "desktop-personal" }),
    });
    return true;
  }, [assertCurrent, continuePersonal]);

  return { identityKey, sharedJob, takeOverShared, continueShared, continuePersonal, startPersonal };
}
