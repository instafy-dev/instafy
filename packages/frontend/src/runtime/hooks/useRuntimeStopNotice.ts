import { useEffect, useRef } from "react";
import type { StatusContextValue } from "../../status/StatusProvider";
import { markIdlePaused } from "../idlePauseRegistry";
import { setRuntimeSizePreference } from "../runtimeSizePreference";
import { isRuntimeLimitReclaimStopReason } from "../unexpectedHostedRuntimeRecovery";

interface UseRuntimeStopNoticeArgs {
  activeProjectId: string | null;
  /** Whether a hosted machine in the active space is up, as its status reads. */
  hostedRuntimeReady: boolean;
  showStatus: StatusContextValue["showStatus"];
  openPanelTab: (panel: "credits") => void;
}

/**
 * Deliberate runtime pauses (idle, credits, memory, a reclaimed slot) get an
 * explained notice instead of looking like a crash. Auto-restart is
 * suppressed for these reasons in unexpectedHostedRuntimeRecovery; the
 * machine wakes when the person writes in the chat, sends or presses Start.
 *
 * Each stop is explained once. A machine that comes up again can be stopped
 * again, so the next stop of the same machine is explained too.
 */
export function useRuntimeStopNotice({
  activeProjectId,
  hostedRuntimeReady,
  showStatus,
  openPanelTab,
}: UseRuntimeStopNoticeArgs) {
  const runtimeStopNoticeRef = useRef<string | null>(null);

  useEffect(() => {
    if (hostedRuntimeReady) {
      runtimeStopNoticeRef.current = null;
    }
  }, [hostedRuntimeReady]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleStopNotice = (event: Event) => {
      const custom = event as CustomEvent<{
        projectId?: string | null;
        kind?: string | null;
        data?: Record<string, unknown> | null;
      }>;
      if (custom.detail?.kind !== "runtime.stopped") {
        return;
      }
      const projectId =
        typeof custom.detail?.projectId === "string" ? custom.detail.projectId.trim() : "";
      if (!projectId || projectId !== activeProjectId) {
        return;
      }
      const reason =
        custom.detail?.data && typeof custom.detail.data.reason === "string"
          ? custom.detail.data.reason.trim().toLowerCase()
          : "";
      const reclaimed = isRuntimeLimitReclaimStopReason(reason);
      if (
        reason !== "idle" &&
        reason !== "credits_exhausted" &&
        reason !== "oom_killed" &&
        !reclaimed
      ) {
        return;
      }
      if (reason === "idle") {
        // Every idle stop holds the space, also one whose notice already
        // showed: a person's request since may have lifted the hold.
        markIdlePaused(projectId);
      }
      const runtimeId =
        custom.detail?.data && typeof custom.detail.data.runtimeId === "string"
          ? custom.detail.data.runtimeId
          : "";
      const noticeKey = `${runtimeId}:${reason}`;
      if (runtimeStopNoticeRef.current === noticeKey) {
        return;
      }
      runtimeStopNoticeRef.current = noticeKey;
      if (reclaimed) {
        // Whether to hold this machine is the recovery listener's call (it
        // knows about this tab's queued work); this only explains the stop.
        showStatus(
          "This space's cloud runtime was paused so another space in your team could use it. Your files are kept, and it starts again when you write in the chat and a runtime is free.",
          "info",
          8000,
          { id: "runtime-paused-reclaimed", forceVisible: true },
        );
      } else if (reason === "idle") {
        showStatus(
          "Hosted machine paused after inactivity. Your files and caches are kept, and it wakes when you write in the chat.",
          "info",
          8000,
          { id: "runtime-paused-idle", forceVisible: true },
        );
      } else if (reason === "oom_killed") {
        const oomCount =
          custom.detail?.data && typeof custom.detail.data.oomCount === "number"
            ? custom.detail.data.oomCount
            : 1;
        showStatus(
          oomCount >= 2
            ? "The hosted machine ran out of memory again (4 GB limit). Boost it to 8 GB (2× credits) or connect your own machine for heavy builds."
            : "The hosted machine ran out of memory (4 GB limit) and stopped. Boost it to 8 GB (2× credits) if this keeps happening.",
          "error",
          12000,
          {
            id: "runtime-oom-killed",
            actionLabel: "Boost machine",
            onAction: () => {
              setRuntimeSizePreference(projectId, "boost");
              showStatus(
                "Boost set (4 CPU · 8 GB · 2× credits). It applies the next time the machine starts.",
                "success",
                6000,
                { id: "runtime-size-change" },
              );
            },
            forceVisible: true,
          },
        );
      } else {
        showStatus(
          "Hosted machine paused: this team is out of credits for today. They refill at 00:00 UTC.",
          "error",
          10000,
          {
            id: "runtime-paused-credits",
            actionLabel: "Open credits",
            onAction: () => openPanelTab("credits"),
            forceVisible: true,
          },
        );
      }
    };
    window.addEventListener("instafy:runtime-lifecycle-event", handleStopNotice as EventListener);
    return () => {
      window.removeEventListener(
        "instafy:runtime-lifecycle-event",
        handleStopNotice as EventListener,
      );
    };
  }, [activeProjectId, openPanelTab, showStatus]);
}
