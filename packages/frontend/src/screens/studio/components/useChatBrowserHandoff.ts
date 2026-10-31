import { useCallback, useEffect, useRef } from "react";
import type { SubmitConversationOptions } from "../../../conversations/useConversation";
import { cancelAgentJob } from "../../../services/runtimeController/jobs";
import type { RunRecord } from "../../../types";
import { continuedSharedBrowserRunId, sharedBrowserTakeoverJob } from "./browserHandoffRouting";
import type { BrowserSessionPage, BrowserSessionPageTarget } from "./browserSessionPages";
import { buildSharedBrowserSubmitMetadata, withPersonalBrowserRuntimeExpectations } from "./sharedBrowserSubmitRouting";
import { BROWSER_AUTO_STARTED_METADATA_KEY, BROWSER_CONTINUES_RUN_METADATA_KEY } from "./browserRequest";
import { LET_OCTO_CONTINUE } from "./useBrowserHumanInput";
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

/** The metadata key naming the browser run a continuation continues. */
export { BROWSER_CONTINUES_RUN_METADATA_KEY };

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
  /**
   * The page on screen; `openedBy` lets Take over on the agent's own tab find
   * its run, and keep that tab unless it is `kept` already.
   */
  page: (BrowserSessionPageTarget & Partial<Pick<BrowserSessionPage, "openedBy" | "kept">>) | null;
  runs: RunRecord[];
  /** The sites of the cards the person pressed in this chat: their OK for each one. */
  browserCardSites?: readonly string[];
  personal: ReturnType<typeof usePersonalBrowserBridge>;
  agentHandle: string;
  onSubmit: (id: string | null, message: string, options?: SubmitConversationOptions) => Promise<void>;
  /**
   * Keeps one of the agent's tabs open past the end of its turn. Take over
   * on such a tab keeps it, so the page the person took stays on screen.
   */
  keepAgentTab?: ((pageId: string) => Promise<unknown>) | null;
};

/**
 * How long Take over waits to keep the agent's tab on screen before it stops
 * the turn anyway: the turn's end closes the agent's tabs that are not kept.
 */
export const TAKE_OVER_KEEP_TAB_WAIT_MS = 1_500;

async function keepAgentTabBriefly(keep: (pageId: string) => Promise<unknown>, pageId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      keep(pageId).catch(() => false),
      new Promise((resolve) => { timer = setTimeout(resolve, TAKE_OVER_KEEP_TAB_WAIT_MS); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

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

/** The chat and its browser, without the page on screen. */
function chatIdentity(value: Options) {
  return JSON.stringify([
    value.userId, value.projectId, value.conversationId, value.transport, value.open,
    value.transport === "shared" ? value.runtimeId : value.personal.ownerId,
  ]);
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
  // A turn sent for the chat's own tab does not depend on the page on screen,
  // which may change meanwhile (Studio brings that tab forward itself).
  const assertSameChat = useCallback((captured: Options) => {
    if (!mounted.current || !latest.current.canWrite || !latest.current.open || !captured.userId || !captured.projectId || !captured.conversationId || chatIdentity(latest.current) !== chatIdentity(captured)) {
      throw new Error("The browser or conversation changed before this task could continue.");
    }
  }, []);
  const sharedJob = sharedBrowserTakeoverJob(options.runs, options.runtimeId, options.page?.id ?? null, {
    openedByAgent: options.page?.openedBy === "agent",
  });
  // The job Take over stops while the browser reports that the agent holds
  // it: its control spans every tab, so this one is found from any tab on
  // screen, a person's own included.
  const sharedJobWhileAgentHolds = sharedBrowserTakeoverJob(options.runs, options.runtimeId, options.page?.id ?? null, {
    openedByAgent: options.page?.openedBy === "agent",
    agentHoldsBrowser: true,
  });

  /**
   * `agentHoldsBrowser`: the browser reports the agent's control right now,
   * so the runtime's one browser job is stopped whichever tab is on screen.
   */
  const takeOverShared = useCallback(async ({ agentHoldsBrowser = false }: { agentHoldsBrowser?: boolean } = {}) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "shared") return false;
    const job = sharedBrowserTakeoverJob(captured.runs, captured.runtimeId, captured.page?.id ?? null, {
      openedByAgent: captured.page?.openedBy === "agent",
      agentHoldsBrowser,
    });
    if (!job) return false;
    // Taking over on one of the agent's own tabs keeps that tab: the turn's
    // end would otherwise close it under the person who just took it.
    const page = captured.page;
    if (captured.keepAgentTab && page?.openedBy === "agent" && page.kept !== true) {
      await keepAgentTabBriefly(captured.keepAgentTab, page.id);
    }
    const result = await cancelAgentJob(job.jobId, "User taking over the browser");
    assertCurrent(captured, epoch);
    // This acknowledges the cancellation request only. The surface separately
    // waits for origin-confirmed human ownership before enabling manual input.
    return result?.ok === true && (result.canceledJobIds.includes(job.jobId) || result.canceledRunIds.includes(job.runId));
  }, [assertCurrent]);

  /**
   * `resolveTab`: the chat's own tab (chatBrowserTab.ts), which the turn is
   * sent for. It is read after the chat is captured, and the chat is checked
   * again once it is in: opening a tab takes a moment, and a chat the person
   * switched to meanwhile never gets this task. Without one (an older
   * browser), the page on screen, as Let Octo continue after a manual step.
   */
  const continueShared = useCallback(async (
    message: string,
    extras?: BrowserContinuationExtras | null,
    resolveTab?: (() => Promise<BrowserSessionPageTarget | null>) | null,
  ) => {
    const captured = latest.current;
    const epoch = generation.current;
    let tab: BrowserSessionPageTarget | null = null;
    if (resolveTab) {
      assertSameChat(captured);
      tab = await resolveTab();
    }
    const assertSendable = tab ? () => assertSameChat(captured) : () => assertCurrent(captured, epoch);
    assertSendable();
    const page = tab ?? captured.page;
    if (captured.transport !== "shared" || !captured.runtimeId || !page) return false;
    const shown = displayOptions(message, extras);
    await captured.onSubmit(captured.conversationId, shown.text, {
      agentHandles: [captured.agentHandle],
      imageFiles: [],
      editorState: null,
      expectedLaneIdle: true,
      requireDispatch: true,
      ...(shown.dispatchInput ? { dispatchInput: shown.dispatchInput } : {}),
      assertDispatchCurrent: assertSendable,
      runtimeOverride: { runtimeId: captured.runtimeId, runtimeDisplayName: null, preferRuntime: true },
      metadata: buildSharedBrowserSubmitMetadata({
        baseMetadata: extras?.metadata ?? null,
        browserPageTarget: page,
        runtimeId: captured.runtimeId,
        cardSites: captured.browserCardSites,
      }),
    });
    return true;
  }, [assertCurrent, assertSameChat]);

  /**
   * Let Octo continue in Instafy's browser, after the person took over or did
   * a manual step: the new run names the run it continues, so the runtime
   * can keep that run's approvals (it checks that the run is the last one
   * that held this browser, for this person on this page). The chat shows
   * the button's own words; the turn gets the whole prompt. `metadata` joins
   * the prompt's, as a retry's link to the failure it retries does.
   */
  const continueSharedRun = useCallback(async (message: string, metadata?: Record<string, unknown> | null) => {
    const captured = latest.current;
    const continuesRunId = continuedSharedBrowserRunId(captured.runs, {
      conversationId: captured.conversationId,
      runtimeId: captured.runtimeId,
      pageId: captured.page?.id ?? null,
      userId: captured.userId,
    });
    return continueShared(message, {
      display: LET_OCTO_CONTINUE,
      metadata: {
        ...(metadata ?? {}),
        ...(continuesRunId ? { [BROWSER_CONTINUES_RUN_METADATA_KEY]: continuesRunId } : {}),
      },
    });
  }, [continueShared]);

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

  /** Let Octo continue in the browser on this device: the chat shows the button's own words too. */
  const continuePersonalRun = useCallback(
    (message: string, approvalMode: PersonalBrowserApprovalMode, metadata?: Record<string, unknown> | null) =>
      continuePersonal(message, approvalMode, { display: LET_OCTO_CONTINUE, metadata }),
    [continuePersonal],
  );

  /**
   * Try again on a turn that a press of Let Octo continue started: the same
   * press again, in the chat's browser, with the retry's metadata. The
   * browser on this device takes the person's own approval choice, as a
   * press there does. False, with nothing sent, while the chat's browser is
   * not open.
   */
  const retryContinue = useCallback(async (message: string, metadata: Record<string, unknown>) => {
    const captured = latest.current;
    if (!captured.open) return false;
    if (captured.transport !== "personal") return continueSharedRun(message, metadata);
    return continuePersonalRun(message, resolvePersonalBrowserApprovalMode({
      status: captured.personal.status,
      choice: captured.personal.approvalModeChoice ?? null,
    }), metadata);
  }, [continuePersonalRun, continueSharedRun]);

  const startPersonal = useCallback(async (message: string, extras?: BrowserContinuationExtras | null) => {
    const captured = latest.current;
    const epoch = generation.current;
    assertCurrent(captured, epoch);
    if (captured.transport !== "personal") return false;
    // The pending handoff outlives the status request, which Desktop clears
    // on the navigations that follow a sign-in.
    if (captured.personal.status?.humanInputRequest || captured.personal.pendingHandoff) {
      throw new Error("Finish the current manual step and choose Let Octo continue, or pause the browser, before starting another browser task.");
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

  return {
    identityKey, sharedJob, sharedJobWhileAgentHolds, takeOverShared, continueShared, continueSharedRun,
    continuePersonal, continuePersonalRun, retryContinue, startPersonal,
  };
}
