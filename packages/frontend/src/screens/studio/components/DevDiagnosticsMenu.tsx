import { useCallback } from "react";
import { Copy } from "iconoir-react";
import { AppVersionLabel } from "../../../components/AppVersionLabel";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { FactGrid } from "../../../components/FactGrid";
import { Text } from "../../../components/Text";
import { Toggle } from "../../../components/Toggle";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { instafyBuildInfo } from "../../../config/buildInfo";
import { RuntimeTunnelDetails, type TunnelCopyMode } from "../../../runtime/components/RuntimeTunnelDetails";
import { RuntimeStateIndicator } from "../../../runtime/runtimeMenuShared";
import type { RuntimeMenuOption } from "../../../runtime/useRuntimeMenu";
import { useStatus } from "../../../status/useStatus";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { useTouchModeDebugState } from "../../../hooks/useTouchLikeInput";

export interface DevDiagnosticsMenuProps {
  onClose: () => void;
  onShowLogs?: () => void;
  hasLogs?: boolean;
  onShowAppLogs?: () => void;
  hasAppLogs?: boolean;
  onShowBugReports?: () => void;
  onReportBug?: () => void;
  shakeToReportEnabled?: boolean;
  onToggleShakeToReport?: (enabled: boolean) => void;
  onSimulateShakeToReport?: () => void;
  onTestShakeToReport?: () => void;
  shakeToReportStatus?: string;
  shakeToReportDetail?: string | null;
  runtimeOptions: RuntimeMenuOption[];
  onCopyTunnel: (mode: TunnelCopyMode, runtimeId: string | null) => void;
}

const SECTION_CLASS = `mt-4 border-t border-slate-200/70 pt-4 ${DARK_DIVIDER_BORDER_CLASS}`;

export function DevDiagnosticsMenu({
  onClose,
  onShowLogs,
  hasLogs,
  onShowAppLogs,
  hasAppLogs,
  onShowBugReports,
  onReportBug,
  shakeToReportEnabled = false,
  onToggleShakeToReport,
  onSimulateShakeToReport,
  onTestShakeToReport,
  shakeToReportStatus,
  shakeToReportDetail,
  runtimeOptions,
  onCopyTunnel,
}: DevDiagnosticsMenuProps) {
  const { showStatus } = useStatus();
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const hasWebContainer = import.meta.env.VITE_USE_WEBCONTAINER === "true";
  const environment = import.meta.env.MODE;
  const supabaseHost = (() => {
    if (!supabaseUrl) {
      return null;
    }
    try {
      return new URL(supabaseUrl).host;
    } catch {
      return null;
    }
  })();
  const backend = supabaseUrl
    ? supabaseHost
      ? `Remote Supabase · ${supabaseHost}`
      : "Remote Supabase"
    : "Harness";
  const buildDriver = hasWebContainer ? "WebContainer" : "Supabase Edge";
  const {
    effectiveTouchLikeInput,
    hardwareTouchLikeInput,
    storedOverride,
    urlOverride,
    setStoredOverride,
  } = useTouchModeDebugState();
  const touchModeForcedByUrl = urlOverride !== null;
  const touchModeDescription = touchModeForcedByUrl
    ? `URL override is ${urlOverride ? "on" : "off"} via touchMode=${urlOverride ? "1" : "0"}.`
    : storedOverride !== null
      ? `Stored override is ${storedOverride ? "on" : "off"}.`
      : `Automatic detection is ${hardwareTouchLikeInput ? "touch-like" : "pointer-like"}.`;

  const handleCopyBuildInfo = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(instafyBuildInfo, null, 2));
      showStatus("Build info copied.", "success", 2500, { presentation: "confirmation" });
    } catch {
      showStatus("Copy failed — clipboard unavailable.", "warning", 3500);
    }
  }, [showStatus]);

  return (
    <div className="flex max-h-[min(90dvh,42rem)] flex-col text-sm text-slate-700 dark:text-slate-200">
      <StudioDialogHeader title="Diagnostics" onClose={onClose} closeLabel="Close diagnostics" />
      <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
        <div className="grid gap-2 sm:grid-cols-2">
          {onShowAppLogs ? (
            <Button
              onPress={() => {
                onClose();
                onShowAppLogs();
              }}
              variant="secondary"
              size="sm"
              radius="2xl"
              fullWidth
              className="justify-between"
            >
              <Text as="span" variant="bodyStrong" tone="inherit">
                View app logs
              </Text>
              {hasAppLogs ? (
                <span
                  className="inline-flex h-2 w-2 rounded-full bg-primary-500"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          ) : null}
          {onShowLogs ? (
            <Button
              onPress={() => {
                onClose();
                onShowLogs();
              }}
              variant="secondary"
              size="sm"
              radius="2xl"
              fullWidth
              className="justify-between"
            >
              <Text as="span" variant="bodyStrong" tone="inherit">
                View runtime logs
              </Text>
              {hasLogs ? (
                <span
                  className="inline-flex h-2 w-2 rounded-full bg-primary-500"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          ) : null}
          {onReportBug ? (
            <Button
              onPress={() => {
                onClose();
                onReportBug();
              }}
              variant="secondary"
              size="sm"
              radius="2xl"
              fullWidth
              data-testid="diagnostics-report-bug"
            >
              <Text as="span" variant="bodyStrong" tone="inherit">
                Report issue
              </Text>
            </Button>
          ) : null}
          {onShowBugReports ? (
            <Button
              onPress={() => {
                onClose();
                onShowBugReports();
              }}
              variant="secondary"
              size="sm"
              radius="2xl"
              fullWidth
              data-testid="diagnostics-view-bug-reports"
            >
              <Text as="span" variant="bodyStrong" tone="inherit">
                View bug reports
              </Text>
            </Button>
          ) : null}
        </div>

        <div className={SECTION_CLASS}>
          <Text variant="overline" tone="subtle">
            Build
          </Text>
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <AppVersionLabel className="block truncate font-medium" />
              {instafyBuildInfo.gitBranch && instafyBuildInfo.gitBranch !== "main" ? (
                <Text as="p" variant="caption" tone="muted" className="truncate">
                  Branch {instafyBuildInfo.gitBranch}
                </Text>
              ) : null}
            </div>
            <IconButton
              type="button"
              variant="ghost"
              size="xs"
              radius="full"
              onPress={() => void handleCopyBuildInfo()}
              aria-label="Copy build info"
              data-testid="diagnostics-copy-build-info"
              className="shrink-0 text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </div>
          <FactGrid
            className="mt-3"
            valueVariant="caption"
            valueTone="secondary"
            items={[
              { label: "Environment", value: environment },
              { label: "Backend", value: backend },
              { label: "Build driver", value: buildDriver },
            ]}
          />
        </div>

        <div className={SECTION_CLASS}>
          <Text variant="overline" tone="subtle">
            Overrides
          </Text>
            {onToggleShakeToReport ? (
              <div className="mt-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Text as="p" variant="bodyStrong" tone="primary">
                      Shake to report
                    </Text>
                    <Text as="p" variant="caption" tone="muted">
                      {shakeToReportStatus ?? "Off"}
                    </Text>
                    {shakeToReportDetail ? (
                      <Text as="p" variant="caption" tone="subtle" className="mt-1">
                        {shakeToReportDetail}
                      </Text>
                    ) : null}
                  </div>
                  <Toggle
                    aria-label="Shake to report"
                    isSelected={shakeToReportEnabled}
                    onChange={onToggleShakeToReport}
                    size="md"
                    className="justify-end"
                    data-testid="diagnostics-shake-report-toggle"
                  />
                </div>
                {onSimulateShakeToReport || onTestShakeToReport ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {onSimulateShakeToReport ? (
                      <Button
                        onPress={onSimulateShakeToReport}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        data-testid="diagnostics-simulate-shake-report"
                      >
                        Simulate shake event
                      </Button>
                    ) : null}
                    {onTestShakeToReport ? (
                      <Button
                        onPress={onTestShakeToReport}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        data-testid="diagnostics-test-shake-report"
                      >
                        Test report dialog
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className={onToggleShakeToReport ? "mt-4" : "mt-2"}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Text as="p" variant="bodyStrong" tone="primary">
                    Touch layout override
                  </Text>
                  <Text as="p" variant="caption" tone="muted">
                    {touchModeDescription}
                  </Text>
                </div>
                <Toggle
                  aria-label="Force touch layout"
                  isSelected={effectiveTouchLikeInput}
                  onChange={(selected) => setStoredOverride(selected)}
                  isDisabled={touchModeForcedByUrl}
                  size="md"
                  className="justify-end"
                  data-testid="diagnostics-touch-mode-toggle"
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  onPress={() => setStoredOverride(null)}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  isDisabled={touchModeForcedByUrl && storedOverride === null}
                  data-testid="diagnostics-touch-mode-reset"
                >
                  Use automatic detection
                </Button>
                <Text as="span" variant="caption" tone="subtle">
                  URL: ?touchMode=1 or ?touchMode=0
                </Text>
              </div>
            </div>
        </div>

        {runtimeOptions.length > 0 ? (
          <div className={SECTION_CLASS}>
            <Text variant="overline" tone="subtle">
              Runtimes
            </Text>
            <div className="mt-2 space-y-2">
              {runtimeOptions.map((option) => (
                <Card
                  key={option.id ?? option.label}
                  tone="raised"
                  radius="2xl"
                  shadow="none"
                  padding="sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Text as="p" variant="bodyStrong" tone="primary" className="truncate">
                        {option.label}
                      </Text>
                      <Text as="p" variant="caption" tone="muted" className="truncate">
                        {option.detail ?? "No endpoint published"}
                      </Text>
                    </div>
                    <RuntimeStateIndicator option={option} />
                  </div>
                  {option.tunnel ? (
                    <RuntimeTunnelDetails
                      grant={option.tunnel}
                      className="mt-2 flex flex-wrap items-center gap-2 text-xxs text-slate-500 dark:text-slate-400"
                      onCopy={(mode) => onCopyTunnel(mode, option.id ?? null)}
                      copyTestId="diagnostics-copy-tunnel"
                    />
                  ) : null}
                </Card>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
