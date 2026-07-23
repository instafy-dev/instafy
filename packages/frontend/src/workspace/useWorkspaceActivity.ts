import { useCallback, useEffect, useMemo, useRef } from "react";
import { controllerClient } from "../sdk/instafy";
import { useProject } from "../projects/useProject";
import { useConversations } from "../conversations/ConversationsProvider";
import { isRunActivelyProgressing } from "../conversations/runLiveness";
import { useRuntime } from "../runtime/useRuntime";
import type { RunRecord } from "../types";

const IDLE_THRESHOLD_MS = 90_000;
const CHECK_INTERVAL_MS = 15_000;
const ACTIVE_HEARTBEAT_MIN_INTERVAL_MS = 30_000;
// Periodic re-send while continuously active: the controller persists genuine
// activity durably (idle-stop decisions survive restarts), so a long working
// session must refresh it even when no status transition happens.
const ACTIVE_RESEND_INTERVAL_MS = 5 * 60_000;
const runtimeControllerEnabled = controllerClient.core.enabled;
function now() {
  return Date.now();
}

export function hasActiveRunsForProject(
  projectId: string | null | undefined,
  runs: Record<string, RunRecord> | null | undefined,
  leasedRunIds: Record<string, true> | null | undefined
): boolean {
  if (!projectId) {
    return false;
  }

  const leaseCount = Object.keys(leasedRunIds ?? {}).length;
  if (leaseCount > 0) {
    return true;
  }

  if (!runs) {
    return false;
  }

  const nowMs = Date.now();
  return Object.values(runs).some((run) => {
    if (!run) {
      return false;
    }
    if (run.projectId !== projectId) {
      return false;
    }
    return isRunActivelyProgressing(run, nowMs);
  });
}

export function useWorkspaceActivity(options?: { idleThresholdMs?: number }) {
  const { activeProjectId, projectCapabilitiesResolved, canWriteProject } = useProject();
  const canReportActivity =
    projectCapabilitiesResolved === false ? false : canWriteProject !== false;
  const { conversations } = useConversations();
  const runtimeContext = useRuntime();
  const { runs, leasedRunIds } = runtimeContext;
  const controllerProjectMissing = runtimeContext.runtime.controllerProjectMissing;
  const hasControllerConversation = useMemo(
    () => conversations.some((conversation) => typeof conversation.controllerId === "string" && conversation.controllerId.length > 0),
    [conversations]
  );
  const idleThresholdMs = options?.idleThresholdMs ?? IDLE_THRESHOLD_MS;
  const lastInteractionRef = useRef<number>(now());
  const currentStatusRef = useRef<"active" | "idle" | null>(null);
  const pendingRef = useRef<Promise<boolean> | null>(null);
  const hasActiveRunRef = useRef(false);
  const previousActiveRunRef = useRef(false);
  const lastSentAtRef = useRef(0);

  const hasActiveControllerRun = useMemo(() => {
    return hasActiveRunsForProject(activeProjectId, runs, leasedRunIds);
  }, [activeProjectId, leasedRunIds, runs]);

  useEffect(() => {
    hasActiveRunRef.current = hasActiveControllerRun;
  }, [hasActiveControllerRun]);

  const sendStatus = useCallback(
    (status: "active" | "idle", timestamp: number) => {
      if (
        !runtimeControllerEnabled ||
        !canReportActivity ||
        !activeProjectId ||
        controllerProjectMissing ||
        !hasControllerConversation
      ) {
        return;
      }

      if (status === "idle" && hasActiveRunRef.current) {
        return;
      }

      if (
        currentStatusRef.current === status &&
        status === "active" &&
        now() - lastSentAtRef.current < ACTIVE_RESEND_INTERVAL_MS
      ) {
        return;
      }
      lastSentAtRef.current = now();

      const idleTtlSeconds = Math.max(30, Math.ceil(idleThresholdMs / 1000));
      const lastInteractionAt = new Date(timestamp).toISOString();
      const request = controllerClient.runtimes.updateActivity({
        projectId: activeProjectId,
        status,
        idleTtlSeconds,
        lastInteractionAt
      })
        .then((ok) => {
          if (ok) {
            currentStatusRef.current = status;
          } else {
            currentStatusRef.current = null;
          }
          return ok;
        })
        .catch((error) => {
          console.warn("[workspace-activity] failed to update activity:", error);
          currentStatusRef.current = null;
          return false;
        })
        .finally(() => {
          pendingRef.current = null;
        });

      pendingRef.current = request;
    },
    [activeProjectId, canReportActivity, controllerProjectMissing, hasControllerConversation, idleThresholdMs]
  );

  useEffect(() => {
    if (!runtimeControllerEnabled || !canReportActivity || controllerProjectMissing || !hasControllerConversation) {
      return;
    }

    if (!activeProjectId) {
      previousActiveRunRef.current = hasActiveControllerRun;
      return;
    }

    if (hasActiveControllerRun && !previousActiveRunRef.current) {
      const activeTimestamp = now();
      lastInteractionRef.current = activeTimestamp;
      sendStatus("active", activeTimestamp);
    }

    previousActiveRunRef.current = hasActiveControllerRun;
  }, [activeProjectId, canReportActivity, controllerProjectMissing, hasActiveControllerRun, hasControllerConversation, sendStatus]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !canReportActivity || controllerProjectMissing || !hasControllerConversation) {
      return;
    }

    currentStatusRef.current = null;

    if (!activeProjectId) {
      return;
    }

    const initialTimestamp = now();
    lastInteractionRef.current = initialTimestamp;
    sendStatus("active", initialTimestamp);
  }, [activeProjectId, canReportActivity, controllerProjectMissing, hasControllerConversation, sendStatus]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !canReportActivity || controllerProjectMissing || !hasControllerConversation) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const handleActive = () => {
      lastInteractionRef.current = now();
      if (currentStatusRef.current === "idle") {
        sendStatus("active", lastInteractionRef.current);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        handleActive();
        return;
      }
      // Avoid sending an immediate idle signal when the tab is backgrounded.
      // We rely on the normal idle threshold instead so short tab switches
      // don't release runtime leases mid-run (especially if SSE state is stale).
    };

    const wheelOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("pointerdown", handleActive, true);
    window.addEventListener("keydown", handleActive, true);
    window.addEventListener("focus", handleActive, true);
    window.addEventListener("wheel", handleActive, wheelOptions);
    document.addEventListener("visibilitychange", handleVisibility, true);

    return () => {
      window.removeEventListener("pointerdown", handleActive, true);
      window.removeEventListener("keydown", handleActive, true);
      window.removeEventListener("focus", handleActive, true);
      window.removeEventListener("wheel", handleActive, wheelOptions);
      document.removeEventListener("visibilitychange", handleVisibility, true);
    };
  }, [canReportActivity, controllerProjectMissing, hasControllerConversation, sendStatus]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !canReportActivity || controllerProjectMissing || !hasControllerConversation) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!activeProjectId) {
        return;
      }
      const elapsed = now() - lastInteractionRef.current;
      if (hasActiveControllerRun) {
        const heartbeatThreshold = Math.max(
          ACTIVE_HEARTBEAT_MIN_INTERVAL_MS,
          Math.floor(idleThresholdMs / 2)
        );
        if (elapsed >= heartbeatThreshold) {
          const timestamp = now();
          lastInteractionRef.current = timestamp;
          sendStatus("active", timestamp);
        }
        return;
      }
      if (elapsed >= idleThresholdMs && currentStatusRef.current !== "idle") {
        sendStatus("idle", lastInteractionRef.current);
        return;
      }
      // Still genuinely active (recent interaction): refresh the durable
      // activity record so a long session never looks idle server-side.
      if (
        currentStatusRef.current === "active" &&
        elapsed < idleThresholdMs &&
        now() - lastSentAtRef.current >= ACTIVE_RESEND_INTERVAL_MS
      ) {
        sendStatus("active", lastInteractionRef.current);
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    activeProjectId,
    canReportActivity,
    controllerProjectMissing,
    hasActiveControllerRun,
    hasControllerConversation,
    idleThresholdMs,
    sendStatus,
  ]);
}
