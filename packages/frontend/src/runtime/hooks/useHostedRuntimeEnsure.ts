import { useCallback, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type ControllerRuntimeStatusEntry,
} from "../../sdk/instafy";
import { isBrowserRuntimeClaimActive } from "../browserRuntimeClaimRegistry";
import { clearIdlePaused, clearManualStop, clearRestoredAwaitingIntent } from "../idlePauseRegistry";
import {
  hostedRuntimeLimitDetailsFromError,
  type HostedRuntimeLimitErrorDetails,
} from "../hostedRuntimeLimitError";
import { getRuntimeSizePreference } from "../runtimeSizePreference";
import {
  isHostedRuntime,
  runtimeEntryIsBooting,
  runtimeEntryIsReady,
  runtimeEntryIsStopping,
} from "../utils/runtimeEntry";
import { getDefaultRuntimeMetadata } from "../utils/webdevRuntime";
import type { ShowStatusFn } from "./types";

export interface EnsureHostedRuntimeOptions {
  /** Request a machine even when a hosted runtime row already looks like it is starting. */
  force?: boolean;
  /**
   * Let the controller replace a launch that has not come up after five
   * minutes instead of handing it back. Sent only on the user's own retry.
   */
  replaceStalledLaunch?: boolean;
}

/**
 * Shown when a retry of a stalled launch fails for a reason the ensure has
 * no message of its own for.
 */
export const STALLED_LAUNCH_RETRY_FAILED_MESSAGE =
  "Couldn't restart the workspace yet. Try again in a minute.";

interface UseHostedRuntimeEnsureOptions {
  enabled: boolean;
  projectId: string | null;
  runtimeStatuses: ControllerRuntimeStatusEntry[];
  runtimeStatusesResolved: boolean;
  refreshRuntimeStatuses: () => Promise<void>;
  showStatus: ShowStatusFn;
  setRuntimeEnsureError: (message: string | null) => void;
  setRuntimeEnsureLimit: (details: HostedRuntimeLimitErrorDetails | null) => void;
  showDesktopRuntimeHelp: () => void;
  /** The latest person's stop known in the space (useHostedRuntimeStopAtMs). */
  hostedRuntimeStopAtMs?: number | null;
}

export function useHostedRuntimeEnsure({
  enabled,
  projectId,
  runtimeStatuses,
  runtimeStatusesResolved,
  refreshRuntimeStatuses,
  showStatus,
  setRuntimeEnsureError,
  setRuntimeEnsureLimit,
  showDesktopRuntimeHelp,
  hostedRuntimeStopAtMs = null,
}: UseHostedRuntimeEnsureOptions) {
  const [hostedRuntimeEnsuring, setHostedRuntimeEnsuring] = useState(false);
  // Limit details of the most recent ensure failure, or null when the last
  // attempt succeeded or failed for another reason. Written synchronously so
  // a caller awaiting `ensureHostedRuntime` can read it before React commits
  // the matching `setRuntimeEnsureLimit` update.
  const lastHostedEnsureLimitRef = useRef<HostedRuntimeLimitErrorDetails | null>(null);
  // The request already on its way for a space. An explicit request lifts the
  // holds, which wakes the auto-start effects; they call back in before
  // `hostedRuntimeEnsuring` is set and wait on this one instead of asking the
  // controller for a second machine.
  const inFlightEnsureRef = useRef<{ projectId: string; request: Promise<boolean> } | null>(null);
  const debugLog = useCallback((message: string, data?: unknown) => {
    if (typeof window === "undefined") {
      return;
    }
    const bucket =
      window.__INSTAFY_RUNTIME_DEBUG__ ??
      (window.__INSTAFY_RUNTIME_DEBUG__ = []);
    bucket.push({
      time: Date.now(),
      message,
      data,
    });
    if (bucket.length > 200) {
      bucket.shift();
    }
  }, []);

  const getLatestRuntimeStatuses = useCallback(() => {
    if (typeof window === "undefined") {
      return runtimeStatuses;
    }
    const runtimeWindow = window as typeof window & {
      __INSTAFY_RUNTIME__?: { getSnapshot?: () => { runtimeStatuses?: unknown } };
    };
    const snapshot = runtimeWindow.__INSTAFY_RUNTIME__?.getSnapshot?.();
    const statuses = Array.isArray(snapshot?.runtimeStatuses)
      ? (snapshot?.runtimeStatuses as ControllerRuntimeStatusEntry[]).filter(Boolean)
      : null;
    return statuses ?? runtimeStatuses;
  }, [runtimeStatuses]);

  const resolveEffectiveProjectId = useCallback(() => {
    if (projectId && projectId.trim().length > 0) {
      return projectId;
    }
    if (typeof window !== "undefined") {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_STORE__?: {
          getState?: () => { activeProjectId?: string | null } & Record<string, unknown>;
        };
      };
      const windowProjectId = runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__;
      if (windowProjectId && windowProjectId.trim().length > 0) {
        return windowProjectId.trim();
      }
      const storeProjectId =
        runtimeWindow.__INSTAFY_STORE__?.getState?.()?.activeProjectId ?? null;
      if (typeof storeProjectId === "string" && storeProjectId.trim().length > 0) {
        return storeProjectId.trim();
      }
    }
    return null;
  }, [projectId]);

  const performHostedRuntimeEnsure = useCallback(async (
    options?: Pick<EnsureHostedRuntimeOptions, "replaceStalledLaunch">,
  ) => {
    const replaceStalledLaunch = options?.replaceStalledLaunch === true;
    const effectiveProjectId = resolveEffectiveProjectId();
    if (!enabled || !effectiveProjectId) {
      showStatus("Instafy Cloud runtime is unavailable right now.", "warning", 4000);
      return false;
    }
    if (isBrowserRuntimeClaimActive(effectiveProjectId)) {
      debugLog("hosted-runtime:perform-skip-browser-claim", {
        projectId: effectiveProjectId,
      });
      return true;
    }
    if (hostedRuntimeEnsuring) {
      return true;
    }
    const desiredIdleTtlSeconds =
      controllerClient.core.runtimeIdleTtlSecondsDefault;
    debugLog("hosted-runtime:perform-start", {
      projectId: effectiveProjectId,
      runtimeStatuses: runtimeStatuses.length,
    });
    setRuntimeEnsureError(null);
    setRuntimeEnsureLimit(null);
    lastHostedEnsureLimitRef.current = null;
    setHostedRuntimeEnsuring(true);
    try {
      const latestStatuses = getLatestRuntimeStatuses();
      const existingReadyHosted = latestStatuses.find(
        (entry) =>
          Boolean(entry) &&
          isHostedRuntime(entry) &&
          runtimeEntryIsReady(entry),
      );

      if (existingReadyHosted?.runtimeId) {
        debugLog("hosted-runtime:perform-skip-ready", {
          projectId: effectiveProjectId,
          runtimeId: existingReadyHosted.runtimeId,
          status: existingReadyHosted.status,
          health: existingReadyHosted.health,
        });
        return true;
      }

      const ensureWithTimeout = async (runtimeId: string | null) => {
        const controller = new AbortController();
        const timeoutId =
          typeof window !== "undefined"
            ? window.setTimeout(() => controller.abort(), 45_000)
            : null;
        try {
          return await controllerClient.runtimes.ensure({
            projectId: effectiveProjectId,
            provider: "instafy-cloud",
            displayName: "Hosted Runtime",
            idleTtlSeconds: desiredIdleTtlSeconds,
            metadata: {
              ...getDefaultRuntimeMetadata("studio"),
              sizeId: getRuntimeSizePreference(effectiveProjectId),
            },
            originMode: "hosted",
            originProtocols: ["http"],
            runtimeId: runtimeId ?? undefined,
            signal: controller.signal,
            ...(replaceStalledLaunch ? { replaceStalledLaunch: true } : {}),
          });
        } finally {
          if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
          }
        }
      };

      let result: Awaited<ReturnType<typeof ensureWithTimeout>> = null;
      try {
        result = await ensureWithTimeout(null);
      } catch (error) {
        // One press sends one replacement request; the user can press again.
        if (replaceStalledLaunch) {
          throw error;
        }
        debugLog("hosted-runtime:perform-retry", {
          projectId: effectiveProjectId,
          error: error instanceof Error ? error.message : String(error),
        });
        result = await ensureWithTimeout(null);
      }
      if (!result) {
        showStatus("Unable to request Instafy Cloud runtime", "error", 4000);
        debugLog("hosted-runtime:perform-result-null", { projectId: effectiveProjectId });
        return false;
      }
      setRuntimeEnsureError(null);
      await refreshRuntimeStatuses();
      debugLog("hosted-runtime:perform-success", {
        projectId: effectiveProjectId,
        runtimeId: result.runtimeId,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const limitDetails = hostedRuntimeLimitDetailsFromError(error);
      console.warn("[runtime] Hosted runtime ensure failed:", message);
      debugLog("hosted-runtime:perform-error", {
        projectId: effectiveProjectId,
        error: message,
        limitDetails,
      });
      setRuntimeEnsureError(message);
      setRuntimeEnsureLimit(limitDetails);
      lastHostedEnsureLimitRef.current = limitDetails;
      // Capacity and credit refusals carry their own plain-language message —
      // surface it directly instead of leaving it behind "View details".
      const errorCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      // Both refusals point at the same escape hatch — a self-hosted machine —
      // so give the sentence the control it names instead of leaving it as advice.
      if (errorCode === "insufficient_credits") {
        showStatus(
          message ||
            "This team is out of credits for today, so a hosted machine can't start. Credits refill daily at 00:00 UTC — or connect your own machine.",
          "error",
          10000,
          {
            id: "runtime-insufficient-credits",
            actionLabel: "How to connect one",
            onAction: showDesktopRuntimeHelp,
          },
        );
      } else if (errorCode === "platform_at_capacity") {
        showStatus(
          message ||
            "All hosted machines are in use right now — try again in a few minutes, or connect your own machine.",
          "warning",
          8000,
          {
            id: "runtime-at-capacity",
            actionLabel: "How to connect one",
            onAction: showDesktopRuntimeHelp,
          },
        );
      } else if (replaceStalledLaunch && !limitDetails) {
        // A retry the user pressed must answer. A runtime limit already
        // explains itself where the message waits.
        showStatus(STALLED_LAUNCH_RETRY_FAILED_MESSAGE, "warning", 5000);
      }
      return false;
    } finally {
      setHostedRuntimeEnsuring(false);
    }
  }, [
    debugLog,
    enabled,
    getLatestRuntimeStatuses,
    hostedRuntimeEnsuring,
    refreshRuntimeStatuses,
    runtimeStatuses.length,
    showStatus,
    resolveEffectiveProjectId,
    setRuntimeEnsureError,
    setRuntimeEnsureLimit,
    showDesktopRuntimeHelp,
  ]);

  const requestHostedRuntime = useCallback(async (options?: EnsureHostedRuntimeOptions) => {
    const force = options?.force === true;
    const launchOptions = { replaceStalledLaunch: options?.replaceStalledLaunch === true };
    const effectiveProjectId = resolveEffectiveProjectId();
    // A new request starts with no recorded limit; only a launch that fails
    // with the limit below writes one.
    lastHostedEnsureLimitRef.current = null;
    if (!enabled || !effectiveProjectId) {
      showStatus("Instafy Cloud runtime is unavailable right now.", "warning", 4000);
      debugLog("hosted-runtime:ensure-skip", {
        reason: "unavailable",
        projectId: effectiveProjectId ?? "",
      });
      return false;
    }
    // Every explicit request for a machine (Reconnect, Start, sending a
    // prompt) funnels through here; the auto-ensure effects are gated before
    // they call it. So reaching this point lifts a deliberate Stop, the wait
    // for intent and an idle pause.
    clearManualStop(effectiveProjectId);
    clearRestoredAwaitingIntent(effectiveProjectId);
    clearIdlePaused(effectiveProjectId);
    if (isBrowserRuntimeClaimActive(effectiveProjectId)) {
      debugLog("hosted-runtime:ensure-skip-browser-claim", {
        projectId: effectiveProjectId,
      });
      return true;
    }
    if (hostedRuntimeEnsuring) {
      debugLog("hosted-runtime:ensure-busy", { projectId: effectiveProjectId });
      return true;
    }
    debugLog("hosted-runtime:ensure-request", {
      projectId: effectiveProjectId,
      runtimeStatuses: runtimeStatuses.length,
      runtimeStatusesResolved,
    });
    // Always refresh once when the user (or an explicit action like sending a queued prompt)
    // requests a hosted runtime ensure. Runtimes can stop quickly (ex: low idle TTL) and the
    // in-memory status list can be briefly stale; relying on it can incorrectly report "already
    // running" and leave the UI stuck waiting for a runtime that is actually stopped/offline.
    try {
      await refreshRuntimeStatuses();
    } catch {
      // Ignore refresh failures and fall back to the latest in-memory snapshot.
    }
    debugLog("hosted-runtime:ensure-refreshed", {
      projectId: effectiveProjectId,
      runtimeStatuses: runtimeStatuses.length,
      runtimeStatusesResolved,
    });

    const statusesAfterRefresh = getLatestRuntimeStatuses();

    // A forced request skips the "already starting / already running" reuse
    // below. It exists for two callers. One: the user just stopped the
    // machine that held the org's slot ("Stop blocker and retry"). At that
    // moment this project can still carry the runtime row the controller
    // created for the queued prompt before the slot check refused it: status
    // `requested`, never seen, never going to start. For three minutes that
    // row reads as booting, so a plain ensure would report "starting…" and
    // request nothing, and the queued message would wait until the row aged
    // out. Two: the chat's Try again on a launch that has not come up in five
    // minutes, which still reads as booting and must reach the controller to
    // be replaced. The launch below still reuses a runtime that is actually
    // ready.
    if (force) {
      debugLog("hosted-runtime:ensure-forced", {
        projectId: effectiveProjectId,
        runtimeStatuses: statusesAfterRefresh.length,
      });
      return performHostedRuntimeEnsure(launchOptions);
    }

    const pendingHosted = statusesAfterRefresh.find((entry) => {
      if (!entry) return false;
      if (!isHostedRuntime(entry)) return false;
      return runtimeEntryIsBooting(entry);
    });
    if (pendingHosted?.runtimeId) {
      debugLog("hosted-runtime:ensure-pending", {
        projectId: effectiveProjectId,
        runtimeId: pendingHosted.runtimeId,
        status: pendingHosted.status,
        health: pendingHosted.health,
      });
      showStatus("Instafy Cloud runtime is starting…", "info", 3000);
      return true;
    }

    const existingHosted = statusesAfterRefresh.filter((entry) => {
      if (!entry) return false;
      if (!isHostedRuntime(entry)) return false;
      const status = (entry.status ?? "").toLowerCase();
      const health = (entry.health ?? "").toLowerCase();
      const statusReady = !["stopped", "offline", "failed", "error"].includes(status);
      const healthReady = health === "" || health === "online" || health === "idle";
      return statusReady && healthReady;
    });
    if (existingHosted.length > 0) {
      debugLog("hosted-runtime:ensure-existing", {
        projectId: effectiveProjectId,
        entries: existingHosted.map((entry) => ({
          runtimeId: entry.runtimeId,
          status: entry.status,
          health: entry.health,
        })),
      });
      // Keep `ensureHostedRuntime` non-interrupting: reuse the existing runtime.
      showStatus("Instafy Cloud runtime is already running.", "info", 2500);
      return true;
    }
    debugLog("hosted-runtime:ensure-launch", {
      projectId: effectiveProjectId,
    });
    return performHostedRuntimeEnsure(launchOptions);
  }, [
    debugLog,
    enabled,
    getLatestRuntimeStatuses,
    hostedRuntimeEnsuring,
    runtimeStatusesResolved,
    runtimeStatuses,
    refreshRuntimeStatuses,
    showStatus,
    performHostedRuntimeEnsure,
    resolveEffectiveProjectId,
  ]);

  const ensureHostedRuntime = useCallback(
    (options?: EnsureHostedRuntimeOptions): Promise<boolean> => {
      const projectId = resolveEffectiveProjectId();
      const inFlight = inFlightEnsureRef.current;
      // A forced request never waits on a plain one, which may settle for the
      // very row the force exists to skip.
      if (options?.force !== true && projectId && inFlight?.projectId === projectId) {
        debugLog("hosted-runtime:ensure-joined", { projectId });
        return inFlight.request;
      }
      const request: Promise<boolean> = requestHostedRuntime(options).finally(() => {
        if (inFlightEnsureRef.current?.request === request) {
          inFlightEnsureRef.current = null;
        }
      });
      if (projectId) {
        inFlightEnsureRef.current = { projectId, request };
      }
      return request;
    },
    [debugLog, requestHostedRuntime, resolveEffectiveProjectId],
  );

  // A machine on its way down counts as well as one on its way up: a stop's
  // release reads `requested` on the old launch, and the automatic starts
  // must not take it for no machine at all (runtimeEntryIsStopping).
  const hasHostedRuntimeInProgress = useMemo(() => {
    return runtimeStatuses.some((entry) => {
      if (!entry) {
        return false;
      }
      if (!isHostedRuntime(entry)) return false;
      if (runtimeEntryIsReady(entry)) {
        return true;
      }
      return runtimeEntryIsBooting(entry) || runtimeEntryIsStopping(entry, hostedRuntimeStopAtMs);
    });
  }, [hostedRuntimeStopAtMs, runtimeStatuses]);

  return {
    hostedRuntimeEnsuring,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
    lastHostedEnsureLimitRef,
  } as const;
}
