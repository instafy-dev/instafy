import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Text } from "../../../components/Text";
import { Toggle } from "../../../components/Toggle";
import { RuntimeTunnelDetails, type TunnelCopyMode } from "../../../runtime/components/RuntimeTunnelDetails";
import { RuntimeStateIndicator } from "../../../runtime/runtimeMenuShared";
import type { RuntimeMenuOption } from "../../../runtime/useRuntimeMenu";
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
  const hasSupabase = import.meta.env.VITE_SUPABASE_URL;
  const hasWebContainer = import.meta.env.VITE_USE_WEBCONTAINER === "true";
  const environment = import.meta.env.MODE;
  const hostedMode = hasSupabase ? "Remote Supabase" : "Harness";
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

  return (
    <div className="text-sm text-slate-700">
      <div className="flex items-center justify-between">
        <Text variant="overline" tone="subtle">
          Diagnostics
        </Text>
        <Button onPress={onClose} variant="ghost" size="xs" radius="full">
          Close
        </Button>
      </div>
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
          ) : (
            <Text
              as="span"
              variant="overline"
              tone="subtle"
              className="text-3xs tracking-wide"
            >
              Empty
            </Text>
          )}
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
          className="mt-2 justify-between"
        >
          <Text as="span" variant="bodyStrong" tone="inherit">
            View runtime logs
          </Text>
          {hasLogs ? (
            <span
              className="inline-flex h-2 w-2 rounded-full bg-primary-500"
              aria-hidden="true"
            />
          ) : (
            <Text
              as="span"
              variant="overline"
              tone="subtle"
              className="text-3xs tracking-wide"
            >
              Empty
            </Text>
          )}
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
          className="mt-2"
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
          className="mt-2"
          data-testid="diagnostics-view-bug-reports"
        >
          <Text as="span" variant="bodyStrong" tone="inherit">
            View bug reports
          </Text>
        </Button>
      ) : null}
      {onToggleShakeToReport ? (
        <Card tone="muted" radius="2xl" shadow="none" padding="sm" className="mt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Text as="p" variant="bodyStrong" tone="primary">
                Shake to report
              </Text>
              <Text as="p" variant="caption" tone="muted" className="text-xxs">
                {shakeToReportStatus ?? "Off"}
              </Text>
              {shakeToReportDetail ? (
                <Text as="p" variant="caption" tone="subtle" className="mt-1 text-xxs">
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
            <div className="mt-3 flex flex-wrap gap-2">
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
        </Card>
      ) : null}
      <Card tone="muted" radius="2xl" shadow="none" padding="sm" className="mt-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Text as="p" variant="bodyStrong" tone="primary">
              Touch layout override
            </Text>
            <Text as="p" variant="caption" tone="muted" className="text-xxs">
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
          <Text as="span" variant="caption" tone="subtle" className="text-xxs">
            URL: ?touchMode=1 or ?touchMode=0
          </Text>
        </div>
      </Card>
      <dl className="mt-3 space-y-2 text-xs text-slate-600">
        <div className="flex items-center justify-between">
          <Text as="dt" variant="caption" tone="secondary" className="font-medium">
            Environment
          </Text>
          <dd>
            <Badge size="xs" tone="neutral">
              {environment}
            </Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <Text as="dt" variant="caption" tone="secondary" className="font-medium">
            Backend Mode
          </Text>
          <dd>
            <Badge size="xs" tone="neutral">
              {hostedMode}
            </Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <Text as="dt" variant="caption" tone="secondary" className="font-medium">
            Build Driver
          </Text>
          <dd>
            <Badge size="xs" tone="neutral">
              {buildDriver}
            </Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <Text as="dt" variant="caption" tone="secondary" className="font-medium">
            Supabase URL
          </Text>
          <Text as="dd" variant="caption" tone="muted" className="truncate text-right text-xxs">
            {hasSupabase || "--"}
          </Text>
        </div>
      </dl>
      <Card tone="muted" radius="2xl" shadow="none" padding="sm" className="mt-3">
        <Text as="p" variant="caption" tone="muted" className="text-xxs">
          Provider and hardware setup now live in <Text as="span" variant="caption" tone="secondary">Extensions</Text>, so device diagnostics stay next to the extension rows that actually use them.
        </Text>
      </Card>
      <div className="mt-4 space-y-2 border-t border-slate-200 pt-4">
        <Text variant="overline" tone="subtle">
          Desktop Runtimes
        </Text>
        {runtimeOptions.length === 0 ? (
          <Card tone="muted" radius="2xl" shadow="none" padding="sm" className="border-dashed py-2">
            <Text variant="caption" tone="subtle" className="text-xxs">
              No runtimes detected. Start the desktop agent to stream tunnel details here.
            </Text>
          </Card>
        ) : (
          <div className="space-y-3">
            {runtimeOptions.map((option) => (
              <Card key={option.id ?? option.label} tone="muted" radius="2xl" shadow="none" padding="sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Text as="p" variant="bodyStrong" tone="primary" className="truncate">
                      {option.label}
                    </Text>
                    <Text as="p" variant="caption" tone="muted" className="truncate text-xxs">
                      {option.detail ?? "No endpoint published"}
                    </Text>
                  </div>
                  <RuntimeStateIndicator option={option} />
                </div>
                {option.tunnel ? (
                  <RuntimeTunnelDetails
                    grant={option.tunnel}
                    className="mt-2 flex flex-wrap items-center gap-2 text-xxs text-slate-500"
                    onCopy={(mode) => onCopyTunnel(mode, option.id ?? null)}
                  />
                ) : (
                  <Text as="p" variant="caption" tone="subtle" className="mt-2 text-xxs">
                    Tunnel metadata unavailable
                  </Text>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
