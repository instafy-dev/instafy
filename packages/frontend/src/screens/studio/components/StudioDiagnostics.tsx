import { useCallback, useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { useProjects } from "../../../projects/useProjects";
import { useRuntimeMenuOptions } from "../../../runtime/useRuntimeMenu";
import type { TunnelCopyMode } from "../../../runtime/components/RuntimeTunnelDetails";
import { useAppLogs } from "../../../debug/useAppLogs";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { useWorkspaceControls } from "../workspaceControls";
import { DevDiagnosticsMenu } from "./DevDiagnosticsMenu";
import { BuildLogOverlay } from "./BuildLogOverlay";

/** A single Studio owner keeps diagnostics available from Settings and Support. */
export function StudioDiagnostics({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const controls = useWorkspaceControls();
  const {
    userEmail,
    onShowLogs,
    hasLogs,
    onOpenBugReport,
    shakeToReportEnabled = false,
    onToggleShakeToReport,
    onSimulateShakeToReport,
    onTestShakeToReport,
    shakeToReportStatus,
    shakeToReportDetail,
  } = controls;
  const onOpenBugReportInbox = controls.onOpenBugReportInbox;
  const { activeProjectId } = useProjects();
  const { runtime: runtimeContext, runtimeOptions } = useRuntimeMenuOptions();
  const [appLogsOverlayOpen, setAppLogsOverlayOpen] = useState(false);
  const { logs: appLogs, hasLogs: hasAppLogs, clearLogs: clearAppLogs } = useAppLogs();
  useNativeBackButtonAction(isOpen, () => onOpenChange(false), 260);
  useNativeBackButtonAction(appLogsOverlayOpen, () => setAppLogsOverlayOpen(false), 270);
  useEffect(() => { setAppLogsOverlayOpen(false); }, [userEmail]);
  const handleCopyTunnel = useCallback((mode: TunnelCopyMode, runtimeId: string | null) => {
    void runtimeContext.copyTunnelDetails(mode, runtimeId);
  }, [runtimeContext]);
  const appLogExport = useMemo(() => {
    const payload = {
      createdAt: new Date().toISOString(),
      location: typeof window !== "undefined" ? window.location.href : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      mode: import.meta.env.MODE,
      userEmail,
      activeProjectId,
      logs: appLogs,
    };
    return JSON.stringify(payload, null, 2);
  }, [activeProjectId, appLogs, userEmail]);

  return (
    <>
      <StudioDialogModal
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        isDismissable
        dialogAriaLabel="Diagnostics"
        data-testid="sidebar-dev-diagnostics-modal"
        modalClassName="max-h-[min(90dvh,42rem)] max-w-xl overflow-hidden p-0"
      >
        <DevDiagnosticsMenu
          onClose={() => onOpenChange(false)}
          onShowLogs={onShowLogs}
          hasLogs={hasLogs}
          onShowAppLogs={() => setAppLogsOverlayOpen(true)}
          hasAppLogs={hasAppLogs}
          onShowBugReports={onOpenBugReportInbox}
          onReportBug={onOpenBugReport}
          shakeToReportEnabled={shakeToReportEnabled}
          onToggleShakeToReport={Capacitor.isNativePlatform() ? onToggleShakeToReport : undefined}
          onSimulateShakeToReport={
            Capacitor.isNativePlatform() && onSimulateShakeToReport
              ? () => {
                  onOpenChange(false);
                  onSimulateShakeToReport();
                }
              : undefined
          }
          onTestShakeToReport={
            Capacitor.isNativePlatform() && onTestShakeToReport
              ? () => {
                  onOpenChange(false);
                  onTestShakeToReport();
                }
              : undefined
          }
          shakeToReportStatus={shakeToReportStatus}
          shakeToReportDetail={shakeToReportDetail}
          runtimeOptions={runtimeOptions}
          onCopyTunnel={handleCopyTunnel}
        />
      </StudioDialogModal>
      {appLogsOverlayOpen ? (
        <BuildLogOverlay
          logs={appLogs}
          onClear={clearAppLogs}
          onClose={() => setAppLogsOverlayOpen(false)}
          title="App logs"
          ariaLabel="App logs"
          emptySummary=""
          emptyBody="Warnings, errors, and unhandled exceptions will appear here."
          copyText={appLogExport}
        />
      ) : null}
    </>
  );
}
