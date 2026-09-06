import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logAppInfo, logAppWarn } from "../../../debug/appLogs";
import { useAppLogs } from "../../../debug/useAppLogs";
import { useStatus } from "../../../status/useStatus";
import type { BuildLogEntry } from "../../../types";
import { BugReportDialog } from "./BugReportDialog";
import { BugReportInboxDialog } from "./BugReportInboxDialog";
import { captureCurrentScreenBugReportDraft } from "./bugReportCapture";
import type { BugReportScreenshotDraft } from "./bugReportDrafts";
import {
  BUG_REPORT_DIALOG_STATE_EVENT,
  dispatchBugReportDialogState,
  OPEN_BUG_REPORT_EVENT,
  type OpenBugReportDetail,
} from "./bugReportEvents";
import { requestMotionAccessIfNeeded } from "./motionPermission";
import { controllerClient } from "../../../sdk/instafy";
import { getStoredShakeReportEnabled, setStoredShakeReportEnabled } from "./shakeReportPreference";
import { NATIVE_SHAKE_REPORT_EVENT, useShakeToReport } from "./useShakeToReport";

const SHAKE_SCREENSHOT_TIMEOUT_MS = 3_000;

interface UseStudioBugReportControllerOptions {
  currentUserId: string | null;
  activeProjectId: string | null;
  activeConversationId: string | null;
  activeConversationLocalId: string | null;
  activeRuntimeId: string | null;
  controllerProjectMissing: boolean;
  buildLogs: BuildLogEntry[];
  legacyResolutionToasts?: boolean;
}

export function useStudioBugReportController({
  currentUserId,
  activeProjectId,
  activeConversationId,
  activeConversationLocalId,
  activeRuntimeId,
  controllerProjectMissing,
  buildLogs,
  legacyResolutionToasts = true,
}: UseStudioBugReportControllerOptions) {
  const { hideStatus, showStatus } = useStatus();
  const { logs: appLogs } = useAppLogs();
  const [bugReportOpenForUserId, setBugReportOpenForUserId] = useState<string | null>(null);
  const [bugReportInboxOpenForUserId, setBugReportInboxOpenForUserId] = useState<string | null>(
    null,
  );
  const [bugReportInboxTarget, setBugReportInboxTarget] = useState<{
    userId: string;
    reportId: string;
    requestKey: number;
  } | null>(null);
  const bugReportInboxTargetKeyRef = useRef(0);
  const [supportUnreadSnapshot, setSupportUnreadSnapshot] = useState<{
    userId: string | null;
    count: number;
  }>({ userId: null, count: 0 });
  const supportPollGenerationRef = useRef(0);
  const currentUserIdRef = useRef(currentUserId);
  const resolutionToastUsersRef = useRef(new Map<string, string>());
  const [bugReportSeed, setBugReportSeed] = useState<OpenBugReportDetail | null>(null);
  const [bugReportSessionKey, setBugReportSessionKey] = useState(0);
  const [bugReportInitialScreenshots, setBugReportInitialScreenshots] = useState<
    BugReportScreenshotDraft[]
  >([]);
  const [shakeReportEnabled, setShakeReportEnabled] = useState(() => getStoredShakeReportEnabled());
  const [lastShakeDetectedAt, setLastShakeDetectedAt] = useState<number | null>(null);
  const [lastShakeSource, setLastShakeSource] = useState<string | null>(null);
  const [lastShakeSampleAt, setLastShakeSampleAt] = useState<number | null>(null);
  const [lastShakeSampleMagnitude, setLastShakeSampleMagnitude] = useState<number | null>(null);
  const [lastShakePeakCount, setLastShakePeakCount] = useState(0);
  const [lastShakeSampleSource, setLastShakeSampleSource] = useState<string | null>(null);
  const reportRequestRef = useRef(0);

  useEffect(() => {
    return () => {
      reportRequestRef.current += 1;
    };
  }, [currentUserId]);

  currentUserIdRef.current = currentUserId;
  const bugReportOpen = currentUserId !== null && bugReportOpenForUserId === currentUserId;
  const bugReportInboxOpen =
    currentUserId !== null && bugReportInboxOpenForUserId === currentUserId;
  const supportUnreadCount =
    supportUnreadSnapshot.userId === currentUserId ? supportUnreadSnapshot.count : 0;

  const handleOpenBugReportInbox = useCallback((reportId: string | null = null) => {
    const userId = currentUserIdRef.current;
    if (!userId) return;
    setBugReportInboxTarget(
      reportId
        ? { userId, reportId, requestKey: ++bugReportInboxTargetKeyRef.current }
        : null,
    );
    setBugReportInboxOpenForUserId(userId);
  }, []);
  const isUserSessionCurrent = useCallback(
    (expectedUserId: string) => currentUserIdRef.current === expectedUserId,
    [],
  );

  const refreshSupportNotifications = useCallback(
    async (notifyAboutResolution = true) => {
      const requestUserId = currentUserId;
      if (!requestUserId) {
        setSupportUnreadSnapshot({ userId: null, count: 0 });
        return;
      }
      const generation = ++supportPollGenerationRef.current;
      try {
        const page = await controllerClient.bugReports.listPage(100, null, requestUserId);
        if (
          generation !== supportPollGenerationRef.current ||
          currentUserIdRef.current !== requestUserId
        ) {
          return;
        }
        setSupportUnreadSnapshot({ userId: requestUserId, count: page.unreadCount });
        if (!legacyResolutionToasts || !notifyAboutResolution || page.unnotifiedResolutionCount <= 0) return;
        const claim = await controllerClient.bugReports.claimResolutionAlerts(requestUserId);
        if (currentUserIdRef.current !== requestUserId || claim.claimedCount <= 0) return;
        const toastId = `support-resolution:${claim.latestReportId ?? "reports"}:${
          claim.latestResolvedAt ?? "latest"
        }`;
        resolutionToastUsersRef.current.set(toastId, requestUserId);
        showStatus(
          claim.claimedCount === 1
            ? "Your Instafy support report was resolved."
            : `${claim.claimedCount} of your Instafy support reports were resolved.`,
          "success",
          12_000,
          {
            id: toastId,
            actionLabel: claim.claimedCount === 1 ? "View report" : "View reports",
            nonPreemptive: true,
            onClose: () => {
              if (resolutionToastUsersRef.current.get(toastId) === requestUserId) {
                resolutionToastUsersRef.current.delete(toastId);
              }
            },
            onAction: () => {
              if (currentUserIdRef.current === requestUserId) {
                handleOpenBugReportInbox(claim.latestReportId);
              }
            },
          },
        );
      } catch {
        // The support hub remains manually available. Background polling should
        // never turn a transient controller or connectivity failure into noise.
      }
    },
    [currentUserId, handleOpenBugReportInbox, legacyResolutionToasts, showStatus],
  );

  const handleSupportActivityAcknowledged = useCallback(() => {
    void refreshSupportNotifications(false);
  }, [refreshSupportNotifications]);

  useEffect(() => {
    supportPollGenerationRef.current += 1;
    if (!currentUserId) {
      setSupportUnreadSnapshot({ userId: null, count: 0 });
      return;
    }
    const refreshWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        void refreshSupportNotifications(true);
      }
    };
    refreshWhenVisible();
    const intervalId = window.setInterval(refreshWhenVisible, 20_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      supportPollGenerationRef.current += 1;
    };
  }, [currentUserId, refreshSupportNotifications]);

  useEffect(() => {
    const resolutionToastUsers = resolutionToastUsersRef.current;
    return () => {
      for (const [toastId, toastUserId] of resolutionToastUsers) {
        if (toastUserId === currentUserId) {
          hideStatus(toastId);
          resolutionToastUsers.delete(toastId);
        }
      }
    };
  }, [currentUserId, hideStatus]);

  const waitForAnimationFrames = useCallback(async (count = 2) => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      return;
    }
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    }
  }, []);

  const handleOpenShakeBugReport = useCallback(async () => {
    if (bugReportOpen) {
      logAppInfo("Ignored shake issue report because the issue dialog is already open.");
      return;
    }
    const requestUserId = currentUserIdRef.current;
    if (!requestUserId) return;
    logAppInfo("Opening issue report from shake gesture.");
    const requestId = ++reportRequestRef.current;
    setBugReportSeed(null);
    setBugReportInitialScreenshots([]);
    setBugReportSessionKey((current) => current + 1);
    let captureExpired = false;
    let captureTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Screenshots are best-effort: a stalled animation frame, image/font
      // request, or WebView image decode must not disable reporting itself.
      const screenshot = await Promise.race([
        (async () => {
          await waitForAnimationFrames(2);
          if (captureExpired || requestId !== reportRequestRef.current ||
            currentUserIdRef.current !== requestUserId) return null;
          return captureCurrentScreenBugReportDraft();
        })(),
        new Promise<never>((_resolve, reject) => {
          captureTimeout = setTimeout(() => {
            captureExpired = true;
            reject(new Error(
              "Screenshot capture timed out. You can still send the issue report without a screenshot.",
            ));
          }, SHAKE_SCREENSHOT_TIMEOUT_MS);
        }),
      ]);
      if (!screenshot || requestId !== reportRequestRef.current ||
        currentUserIdRef.current !== requestUserId) return;
      setBugReportInitialScreenshots([screenshot]);
      logAppInfo("Captured current screen for shake issue report.");
    } catch (error) {
      if (requestId !== reportRequestRef.current || currentUserIdRef.current !== requestUserId) return;
      setBugReportInitialScreenshots([]);
      const nextMessage =
        error instanceof Error
          ? error.message
          : "Opened the issue report, but could not capture the current screen.";
      logAppWarn(`Shake issue report could not capture the current screen. ${nextMessage}`);
      showStatus(nextMessage, "info", 4000);
    } finally {
      clearTimeout(captureTimeout);
    }
    if (requestId !== reportRequestRef.current || currentUserIdRef.current !== requestUserId) return;
    setBugReportOpenForUserId(requestUserId);
    logAppInfo("Issue report dialog opened from shake gesture.");
  }, [bugReportOpen, showStatus, waitForAnimationFrames]);

  const handleOpenManualBugReport = useCallback(async (detail?: OpenBugReportDetail | null) => {
    const requestUserId = currentUserIdRef.current;
    if (!requestUserId) return;
    reportRequestRef.current += 1;
    setBugReportSeed(detail ?? null);
    setBugReportInitialScreenshots([]);
    setBugReportSessionKey((current) => current + 1);
    setBugReportOpenForUserId(requestUserId);
  }, []);

  const handleToggleShakeReport = useCallback(
    async (enabled: boolean) => {
      setLastShakeDetectedAt(null);
      setLastShakeSource(null);
      setLastShakeSampleAt(null);
      setLastShakeSampleMagnitude(null);
      setLastShakePeakCount(0);
      setLastShakeSampleSource(null);
      if (!enabled) {
        setShakeReportEnabled(false);
        setStoredShakeReportEnabled(false);
        logAppInfo("Shake to report disabled.");
        return;
      }

      setShakeReportEnabled(true);
      setStoredShakeReportEnabled(true);
      const motionPermission = await requestMotionAccessIfNeeded().catch(() => "unsupported" as const);
      if (motionPermission === "granted") {
        logAppInfo("Motion access granted for shake to report.");
      } else if (motionPermission === "denied") {
        logAppWarn("Motion access denied for shake to report. Relying on native shake bridge only.");
        showStatus(
          "Motion access is denied. Instafy will still rely on the native shake bridge on iPhone.",
          "info",
          4500,
        );
      } else {
        logAppInfo("Shake to report enabled without a motion permission prompt.");
      }
      logAppInfo("Shake to report enabled.");
    },
    [showStatus],
  );

  const handleSimulateShakeReport = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    setShakeReportEnabled(true);
    setStoredShakeReportEnabled(true);
    logAppInfo("Simulated shake issue report triggered from Diagnostics.");
    const timestamp = Date.now();
    setLastShakeDetectedAt(timestamp);
    setLastShakeSource("simulated");
    const dispatch = () => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_SHAKE_REPORT_EVENT, {
          detail: { source: "simulated" },
        }),
      );
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(dispatch);
      });
      return;
    }
    window.setTimeout(dispatch, 0);
  }, []);

  const handleTestShakeReport = useCallback(() => {
    logAppInfo("Manual test issue report triggered from Diagnostics.");
    setLastShakeDetectedAt(Date.now());
    setLastShakeSource("manual-test");
    void handleOpenShakeBugReport();
  }, [handleOpenShakeBugReport]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleOpenBugReport = (event: Event) => {
      const detail = (event as CustomEvent<OpenBugReportDetail>).detail;
      void handleOpenManualBugReport(detail ?? null);
    };
    window.addEventListener(OPEN_BUG_REPORT_EVENT, handleOpenBugReport as EventListener);
    return () => {
      window.removeEventListener(OPEN_BUG_REPORT_EVENT, handleOpenBugReport as EventListener);
    };
  }, [handleOpenManualBugReport]);

  useEffect(() => {
    dispatchBugReportDialogState({ open: bugReportOpen });
    return () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(BUG_REPORT_DIALOG_STATE_EVENT, {
            detail: { open: false },
          }),
        );
      }
    };
  }, [bugReportOpen]);

  useShakeToReport({
    enabled:
      Capacitor.isNativePlatform() &&
      shakeReportEnabled &&
      !bugReportOpen &&
      !bugReportInboxOpen,
    onShake: handleOpenShakeBugReport,
    onShakeDetected: (source) => {
      setLastShakeDetectedAt(Date.now());
      setLastShakeSource(source);
      logAppInfo(source ? `Shake gesture detected (${source}).` : "Shake gesture detected.");
    },
    onDetectorStateChange: (snapshot) => {
      setLastShakeSampleAt(snapshot.lastSampleAt);
      setLastShakeSampleMagnitude(snapshot.lastMagnitude);
      setLastShakePeakCount(snapshot.peakCount);
      setLastShakeSampleSource(snapshot.lastSource);
    },
  });

  const shakeToReportStatus = useMemo(() => {
    if (!Capacitor.isNativePlatform()) {
      return "Available on mobile app only";
    }
    if (!shakeReportEnabled) {
      return "Off";
    }
    if (lastShakeDetectedAt != null) {
      const detectedAt = new Date(lastShakeDetectedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return lastShakeSource
        ? `Last detected ${detectedAt} (${lastShakeSource})`
        : `Last detected ${detectedAt}`;
    }
    if (lastShakeSampleAt != null) {
      return "Monitoring motion";
    }
    return "Waiting for motion samples";
  }, [lastShakeDetectedAt, lastShakeSampleAt, lastShakeSource, shakeReportEnabled]);

  const shakeToReportDetail = useMemo(() => {
    if (!Capacitor.isNativePlatform() || !shakeReportEnabled) {
      return null;
    }
    if (lastShakeSampleAt == null) {
      return "Move or shake the phone once to confirm samples are arriving.";
    }
    const parts = [
      `Last sample ${new Date(lastShakeSampleAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}`,
    ];
    if (lastShakeSampleSource) {
      parts.push(lastShakeSampleSource);
    }
    if (typeof lastShakeSampleMagnitude === "number") {
      parts.push(`mag ${lastShakeSampleMagnitude.toFixed(1)}`);
    }
    parts.push(`peaks ${lastShakePeakCount}`);
    return parts.join(" · ");
  }, [
    lastShakePeakCount,
    lastShakeSampleAt,
    lastShakeSampleMagnitude,
    lastShakeSampleSource,
    shakeReportEnabled,
  ]);

  const dialogs = (
    <>
      <BugReportDialog
        key={`${currentUserId ?? "signed-out"}:${bugReportSessionKey}`}
        isOpen={bugReportOpen}
        currentUserId={currentUserId ?? ""}
        isUserSessionCurrent={isUserSessionCurrent}
        onOpenChange={(open) => {
          setBugReportOpenForUserId(open ? currentUserId : null);
          if (!open) {
            reportRequestRef.current += 1;
            setBugReportSeed(null);
            setBugReportInitialScreenshots([]);
          }
        }}
        initialMessage={bugReportSeed?.message}
        initialDetails={bugReportSeed?.details}
        initialScreenshots={bugReportInitialScreenshots}
        activeProjectId={bugReportSeed?.projectId ?? activeProjectId}
        activeConversationId={activeConversationId}
        activeConversationLocalId={activeConversationLocalId}
        activeRuntimeId={activeRuntimeId}
        controllerProjectMissing={controllerProjectMissing}
        appLogs={appLogs}
        buildLogs={buildLogs}
      />
      <BugReportInboxDialog
        key={`support-inbox:${currentUserId ?? "signed-out"}`}
        isOpen={bugReportInboxOpen}
        currentUserId={currentUserId ?? ""}
        isUserSessionCurrent={isUserSessionCurrent}
        initialReportRequest={
          bugReportInboxTarget?.userId === currentUserId ? bugReportInboxTarget : null
        }
        onOpenChange={(open) => {
          setBugReportInboxOpenForUserId(open ? currentUserId : null);
          if (!open) setBugReportInboxTarget(null);
        }}
        onSupportActivityAcknowledged={handleSupportActivityAcknowledged}
        onReportIssue={() => void handleOpenManualBugReport()}
      />
    </>
  );

  return {
    dialogs,
    shakeToReportEnabled: shakeReportEnabled,
    onToggleShakeToReport: handleToggleShakeReport,
    onSimulateShakeToReport: handleSimulateShakeReport,
    onTestShakeToReport: handleTestShakeReport,
    shakeToReportStatus,
    shakeToReportDetail,
    onOpenBugReport: () => void handleOpenManualBugReport(),
    onOpenBugReportInbox: handleOpenBugReportInbox,
    supportUnreadCount,
  };
}
