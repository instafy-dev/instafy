import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { getStoredShakeReportEnabled, setStoredShakeReportEnabled } from "./shakeReportPreference";
import { NATIVE_SHAKE_REPORT_EVENT, useShakeToReport } from "./useShakeToReport";

interface UseStudioBugReportControllerOptions {
  activeProjectId: string | null;
  activeConversationId: string | null;
  activeConversationLocalId: string | null;
  activeRuntimeId: string | null;
  userEmail: string | null;
  controllerProjectMissing: boolean;
  buildLogs: BuildLogEntry[];
}

export function useStudioBugReportController({
  activeProjectId,
  activeConversationId,
  activeConversationLocalId,
  activeRuntimeId,
  userEmail,
  controllerProjectMissing,
  buildLogs,
}: UseStudioBugReportControllerOptions) {
  const { showStatus } = useStatus();
  const { logs: appLogs } = useAppLogs();
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportInboxOpen, setBugReportInboxOpen] = useState(false);
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
    logAppInfo("Opening issue report from shake gesture.");
    setBugReportSeed(null);
    setBugReportInitialScreenshots([]);
    setBugReportSessionKey((current) => current + 1);
    try {
      await waitForAnimationFrames(2);
      const screenshot = await captureCurrentScreenBugReportDraft();
      setBugReportInitialScreenshots([screenshot]);
      logAppInfo("Captured current screen for shake issue report.");
    } catch (error) {
      setBugReportInitialScreenshots([]);
      const nextMessage =
        error instanceof Error
          ? error.message
          : "Opened the issue report, but could not capture the current screen.";
      logAppWarn(`Shake issue report could not capture the current screen. ${nextMessage}`);
      showStatus(nextMessage, "info", 4000);
    }
    setBugReportOpen(true);
    logAppInfo("Issue report dialog opened from shake gesture.");
  }, [bugReportOpen, showStatus, waitForAnimationFrames]);

  const handleOpenManualBugReport = useCallback(async (detail?: OpenBugReportDetail | null) => {
    setBugReportSeed(detail ?? null);
    setBugReportInitialScreenshots([]);
    setBugReportSessionKey((current) => current + 1);
    setBugReportOpen(true);
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
        key={bugReportSessionKey}
        isOpen={bugReportOpen}
        onOpenChange={(open) => {
          setBugReportOpen(open);
          if (!open) {
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
        userEmail={userEmail}
        controllerProjectMissing={controllerProjectMissing}
        appLogs={appLogs}
        buildLogs={buildLogs}
      />
      <BugReportInboxDialog isOpen={bugReportInboxOpen} onOpenChange={setBugReportInboxOpen} />
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
    onOpenBugReportInbox: () => setBugReportInboxOpen(true),
  };
}
