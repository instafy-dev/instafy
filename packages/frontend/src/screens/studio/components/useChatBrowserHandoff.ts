import { useCallback, useEffect, useRef } from "react";
import type { SubmitConversationOptions } from "../../../conversations/useConversation";
import { cancelAgentJob } from "../../../services/runtimeController/jobs";
import type { RunRecord } from "../../../types";
import { sharedBrowserTakeoverJob } from "./browserHandoffRouting";
import type { BrowserSessionPage, BrowserSessionPageTarget } from "./browserSessionPages";
import { buildSharedBrowserSubmitMetadata, withPersonalBrowserRuntimeExpectations } from "./sharedBrowserSubmitRouting";
import { BROWSER_AUTO_STARTED_METADATA_KEY } from "./browserRequest";
import {
  personalBrowserKnownHosts,
  resolvePersonalBrowserApprovalMode,
  type PersonalBrowserApprovalMode,
} from "./personalBrowserApprovalPolicy";
import type { BrowserTransport, usePersonalBrowserBridge } from "./usePersonalBrowserBridge";

/**
 * How a continuation is shown and recorded. `display` replaces the task in the
 * chat (the task is still what the browser turn receives, and the record keeps
 * it as the dispatched content); `metadata` joins the prompt's metadata.
 * `knownHosts` are the card's hosts, which an owner-tier Desktop treats as the
 * run's sites in routine; they are never recorded.
 */
export type BrowserContinuationExtras = {
  display?: string | null;
  metadata?: Record<string, unknown> | null;
  knownHosts?: readonly string[] | null;
};

function displayOptions(message: string, extras: BrowserContinuationExtras | null | undefined) {
  const display = extras?.display?.trim();
  return display && display !== message.trim()
    ? { text: display, dispatchInput: message }
    : { text: message, dispatchInput: null };
}

type Options = {
  userId: string | null;
  projectId: string | null;
  conversationId: string | null;
  transport: BrowserTransport;
  open: boolean;
  canWrite: boolean;
  runtimeId: string | null;
  /** The page on screen; `openedBy` lets Take over on the agent's own tab find its run. */
  page: (BrowserSessionPageTarget & Pick<BrowserSessionPage, "openedBy">) | null;
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
  const sharedJob = sharedBrowserTakeoverJob(options.runs, options.runtimeId, options.page?.id ?? null, {
    openedByAgent: options.page?.openedBy === "agent",
  });

  const takeOverShared = useCallback(async () => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "shared") return false;
    const job = sharedBrowserTakeoverJob(captured.runs, captured.runtimeId, captured.page?.id ?? null, {
      openedByAgent: captured.page?.openedBy === "agent",
    });
    if (!job) return false;
    const result = await cancelAgentJob(job.jobId, "User taking over the browser");
    assertCurrent(captured, epoch);
    // This acknowledges the cancellation request only. The surface separately
    // waits for origin-confirmed human ownership before enabling manual input.
    return result?.ok === true && (result.canceledJobIds.includes(job.jobId) || result.canceledRunIds.includes(job.runId));
  }, [assertCurrent]);

  const continueShared = useCallback(async (message: string, extras?: BrowserContinuationExtras | null) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "shared" || !captured.runtimeId || !captured.page) return false;
    const shown = displayOptions(message, extras);
    await captured.onSubmit(captured.conversationId, shown.text, {
      agentHandles: [captured.agentHandle],
      imageFiles: [],
      editorState: null,
      expectedLaneIdle: true,
      requireDispatch: true,
      ...(shown.dispatchInput ? { dispatchInput: shown.dispatchInput } : {}),
      assertDispatchCurrent: () => assertCurrent(captured, epoch),
      runtimeOverride: { runtimeId: captured.runtimeId, runtimeDisplayName: null, preferRuntime: true },
      metadata: buildSharedBrowserSubmitMetadata({
        baseMetadata: extras?.metadata ?? null,
        browserPageTarget: captured.page,
        runtimeId: captured.runtimeId,
      }),
    });
    return true;
  }, [assertCurrent]);

  const continuePersonal = useCallback(async (
    message: string,
    approvalMode: PersonalBrowserApprovalMode,
    extras?: BrowserContinuationExtras | null,
  ) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "personal") return false;
    const previousRuntimeId = captured.personal.runtimeOverride?.runtimeId ?? captured.personal.status?.runtimeId;
    let resumedRuntimeId: string | null = null;
    try {
      const knownHosts = personalBrowserKnownHosts(captured.personal.status, approvalMode, extras?.knownHosts);
      const resumed = knownHosts.length > 0
        ? await captured.personal.setAgentControlEnabled(true, approvalMode, knownHosts)
        : await captured.personal.setAgentControlEnabled(true, approvalMode);
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
      const shown = displayOptions(message, extras);
      await captured.onSubmit(captured.conversationId, shown.text, {
        agentHandles: [captured.agentHandle],
        imageFiles: [],
        editorState: null,
        expectedLaneIdle: true,
        requireDispatch: true,
        ...(shown.dispatchInput ? { dispatchInput: shown.dispatchInput } : {}),
        assertDispatchCurrent,
        runtimeOverride,
        metadata: withPersonalBrowserRuntimeExpectations({ ...(extras?.metadata ?? {}), browserTransport: "desktop-personal" }),
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

  const startPersonal = useCallback(async (message: string, extras?: BrowserContinuationExtras | null) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "personal") return false;
    // The pending handoff outlives the status request, which Desktop clears
    // on the navigations that follow a sign-in.
    if (captured.personal.status?.humanInputRequest || captured.personal.pendingHandoff) {
      throw new Error("Finish the current manual step and choose Let AI continue, or pause the browser, before starting another browser task.");
    }
    const runtimeOverride = captured.personal.runtimeOverride;
    if (!runtimeOverride) {
      // A press uses the person's own approval mode. Studio opening the
      // browser by itself asks for routine only from an owner-tier Desktop
      // (never an older host's routine, which submits forms), and never
      // when the person chose Ask.
      const automatic = extras?.metadata?.[BROWSER_AUTO_STARTED_METADATA_KEY] === true;
      return continuePersonal(message, resolvePersonalBrowserApprovalMode({
        status: captured.personal.status,
        choice: captured.personal.approvalModeChoice ?? null,
        automatic,
      }), extras);
    }
    const shown = displayOptions(message, extras);
    await captured.onSubmit(captured.conversationId, shown.text, {
      agentHandles: [captured.agentHandle],
      imageFiles: [],
      editorState: null,
      expectedLaneIdle: true,
      requireDispatch: true,
      ...(shown.dispatchInput ? { dispatchInput: shown.dispatchInput } : {}),
      assertDispatchCurrent: () => {
        assertCurrent(captured, epoch);
        if (latest.current.personal.runtimeOverride?.runtimeId !== runtimeOverride.runtimeId) {
          throw new Error("Browser control changed before the task was sent.");
        }
      },
      runtimeOverride,
      metadata: withPersonalBrowserRuntimeExpectations({ ...(extras?.metadata ?? {}), browserTransport: "desktop-personal" }),
    });
    return true;
  }, [assertCurrent, continuePersonal]);

  return { identityKey, sharedJob, takeOverShared, continueShared, continuePersonal, startPersonal };
}
