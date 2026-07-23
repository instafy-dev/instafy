import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, Refresh } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { formatInstafyBuildLabel } from "../../../config/buildInfo";
import { buildReleaseMetadataDetailRows, type AppReleaseMetadata } from "../../../updates/releaseMetadata";
import {
  controllerClient,
  type ControllerBugReportDetail,
  type ControllerBugReportSummary,
} from "../../../sdk/instafy";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { useStatus } from "../../../status/useStatus";
import { formatBugReportFileSize } from "./bugReportDrafts";
import { BugReportScreenshotModal } from "./BugReportScreenshotModal";

const {
  get: getControllerBugReport,
  list: listControllerBugReports,
} = controllerClient.bugReports;

interface BugReportInboxDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBugReportTimestamp(value: string | null): string {
  if (!value) {
    return "Unknown time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildScreenshotSrc(screenshot: { mediaType: string; dataBase64: string }): string {
  return `data:${screenshot.mediaType};base64,${screenshot.dataBase64}`;
}

function parseBuildInfo(value: unknown): InstafyBuildInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.packageVersion !== "string" || typeof record.builtAt !== "string" || typeof record.releaseId !== "string") {
    return null;
  }
  return {
    app: typeof record.app === "string" ? record.app : "instafy-frontend",
    packageVersion: record.packageVersion,
    gitCommit: typeof record.gitCommit === "string" ? record.gitCommit : null,
    gitCommitShort: typeof record.gitCommitShort === "string" ? record.gitCommitShort : null,
    gitBranch: typeof record.gitBranch === "string" ? record.gitBranch : null,
    builtAt: record.builtAt,
    releaseId: record.releaseId,
  };
}

function formatBuildTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseReleaseMetadata(value: unknown): AppReleaseMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const build = record.build;
  const updates = record.updates;
  const binary = record.binary;
  if (!build || !updates || !binary) {
    return null;
  }
  return value as AppReleaseMetadata;
}

export function BugReportInboxDialog({ isOpen, onOpenChange }: BugReportInboxDialogProps) {
  const { showStatus } = useStatus();
  const [reports, setReports] = useState<ControllerBugReportSummary[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<ControllerBugReportDetail | null>(null);
  const [selectedScreenshotId, setSelectedScreenshotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const selectedSummary = useMemo(
    () => reports.find((report) => report.id === selectedReportId) ?? null,
    [reports, selectedReportId],
  );
  const selectedBuildInfo = useMemo(
    () => parseBuildInfo(selectedReport?.metadata?.build),
    [selectedReport?.metadata],
  );
  const selectedReleaseMetadata = useMemo(
    () => parseReleaseMetadata(selectedReport?.metadata?.release),
    [selectedReport?.metadata],
  );
  const selectedScreenshot = useMemo(
    () => selectedReport?.screenshots.find((entry) => entry.id === selectedScreenshotId) ?? null,
    [selectedReport, selectedScreenshotId],
  );

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const nextReports = await listControllerBugReports(50);
      setReports(nextReports);
      setSelectedReportId((current) => current ?? nextReports[0]?.id ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load bug reports.";
      showStatus(message, "error", 4000);
    } finally {
      setLoading(false);
    }
  }, [showStatus]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadReports();
  }, [isOpen, loadReports]);

  useEffect(() => {
    if (!isOpen || !selectedReportId) {
      setSelectedReport(null);
      setSelectedScreenshotId(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    getControllerBugReport(selectedReportId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedReport(detail);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedReport(null);
          const message = error instanceof Error ? error.message : "Unable to load bug report.";
          showStatus(message, "error", 4000);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedReportId, showStatus]);

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      dialogAriaLabel="Bug reports"
      data-testid="bug-report-inbox-modal"
      modalClassName="max-w-5xl overflow-hidden p-0"
    >
      <div className="max-h-[min(90dvh,52rem)] overflow-hidden" data-bug-report-overlay="true">
        <StudioDialogHeader
          title="Bug reports"
          description="Recent reports for this account, including logs and screenshots."
          trailing={
            <Button onPress={() => void loadReports()} variant="outline" size="sm" radius="full" isDisabled={loading}>
              <Refresh className="h-4 w-4" />
              Refresh
            </Button>
          }
          onClose={() => onOpenChange(false)}
          closeLabel="Close bug reports"
        />

        <div className="grid max-h-[min(90dvh,46rem)] grid-cols-1 overflow-hidden lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="overflow-y-auto border-b border-slate-200/70 p-3 dark:border-slate-800 lg:border-b-0 lg:border-r">
            {loading ? (
              <Text variant="body" tone="secondary">Loading bug reports…</Text>
            ) : reports.length === 0 ? (
              <Text variant="body" tone="secondary">No bug reports yet.</Text>
            ) : (
              <div className="space-y-2">
                {reports.map((report) => (
                  <Card
                    key={report.id}
                    tone={report.id === selectedReportId ? "success" : "default"}
                    radius="2xl"
                    shadow="none"
                    padding="sm"
                    className="cursor-pointer"
                    data-testid={report.id === selectedReportId ? "bug-report-inbox-selected" : undefined}
                    onClick={() => setSelectedReportId(report.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Text variant="bodyStrong" className="line-clamp-2">
                          {report.message}
                        </Text>
                        <Text variant="caption" tone="secondary" className="mt-1 block">
                          {formatBugReportTimestamp(report.createdAt)}
                        </Text>
                      </div>
                      <Badge size="xs" tone="neutral">
                        {report.screenshotCount > 0 ? `${report.screenshotCount} shots` : "No shots"}
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="overflow-y-auto p-5">
            {!selectedReportId ? (
              <Text variant="body" tone="secondary">Select a report to inspect it.</Text>
            ) : loadingDetail && !selectedReport ? (
              <Text variant="body" tone="secondary">Loading report…</Text>
            ) : selectedReport ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Heading level={3}>{selectedReport.message}</Heading>
                    <Text variant="caption" tone="secondary" className="mt-1 block">
                      {formatBugReportTimestamp(selectedReport.createdAt)}
                    </Text>
                  </div>
                  <Button
                    onPress={async () => {
                      try {
                        await writeClipboardText(selectedReport.id);
                        showStatus("Bug report id copied.", "success", 2500);
                      } catch (error) {
                        const message = error instanceof Error ? error.message : "Unable to copy bug report id.";
                        showStatus(message, "error", 3500);
                      }
                    }}
                    variant="outline"
                    size="sm"
                    radius="full"
                  >
                    <ClipboardCheck className="h-4 w-4" />
                    Copy id
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="caption" tone="secondary">Status</Text>
                    <Text variant="bodyStrong" className="mt-1">{selectedReport.status}</Text>
                  </Card>
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="caption" tone="secondary">Space</Text>
                    <Text variant="bodyStrong" className="mt-1 break-all">
                      {selectedReport.projectId ?? "None"}
                    </Text>
                  </Card>
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="caption" tone="secondary">Runtime</Text>
                    <Text variant="bodyStrong" className="mt-1 break-all">
                      {selectedReport.runtimeId ?? "None"}
                    </Text>
                  </Card>
                  {selectedBuildInfo ? (
                    <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                      <Text variant="caption" tone="secondary">Build</Text>
                      <Text variant="bodyStrong" className="mt-1 break-all">
                        {formatInstafyBuildLabel(selectedBuildInfo)}
                      </Text>
                    </Card>
                  ) : null}
                </div>

                {selectedReport.details ? (
                  <Card tone="default" radius="2xl" shadow="none" padding="sm">
                    <Text variant="bodyStrong">Description</Text>
                    <Text variant="body" tone="secondary" className="mt-2 whitespace-pre-wrap">
                      {selectedReport.details}
                    </Text>
                  </Card>
                ) : null}

                <Card tone="default" radius="2xl" shadow="none" padding="sm">
                  <Text variant="bodyStrong">Included context</Text>
                  <div className="mt-2 space-y-1">
                    <Text variant="caption" tone="secondary">Conversation: {selectedReport.conversationId ?? "None"}</Text>
                    <Text variant="caption" tone="secondary">Run: {selectedReport.runId ?? "None"}</Text>
                    <Text variant="caption" tone="secondary">Reporter: {selectedReport.reporterEmail ?? "Unknown"}</Text>
                    <Text variant="caption" tone="secondary">Log entries: {selectedReport.logs.length}</Text>
                    {selectedBuildInfo ? (
                      <>
                        <Text variant="caption" tone="secondary">
                          Release: {selectedBuildInfo.releaseId}
                        </Text>
                        <Text variant="caption" tone="secondary">
                          Built: {formatBuildTimestamp(selectedBuildInfo.builtAt)}
                        </Text>
                        <Text variant="caption" tone="secondary">
                          Branch: {selectedBuildInfo.gitBranch ?? "Unknown"}
                        </Text>
                        <Text variant="caption" tone="secondary">
                          Commit: {selectedBuildInfo.gitCommit ?? selectedBuildInfo.gitCommitShort ?? "Unknown"}
                        </Text>
                      </>
                    ) : null}
                    {selectedReleaseMetadata ? (
                      <>
                        {buildReleaseMetadataDetailRows(selectedReleaseMetadata).map((row) => (
                          <Text key={row.label} variant="caption" tone="secondary">
                            {row.label}: {row.value}
                          </Text>
                        ))}
                      </>
                    ) : null}
                  </div>
                </Card>

                {selectedReport.screenshots.length > 0 ? (
                  <div className="space-y-2">
                    <Text variant="bodyStrong">Screenshots</Text>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {selectedReport.screenshots.map((screenshot) => (
                        <Card key={screenshot.id} tone="default" radius="2xl" shadow="none" padding="sm" className="space-y-3">
                          <button
                            type="button"
                            className="block w-full overflow-hidden rounded-xl"
                            onClick={() => setSelectedScreenshotId(screenshot.id)}
                            aria-label={`Open ${screenshot.fileName} fullscreen`}
                          >
                            <img
                              src={buildScreenshotSrc(screenshot)}
                              alt={screenshot.fileName}
                              className="h-48 w-full rounded-xl object-cover transition-transform hover:scale-[1.01]"
                            />
                          </button>
                          <div>
                            <Text variant="bodyStrong" className="truncate">{screenshot.fileName}</Text>
                            <Text variant="caption" tone="secondary" className="mt-1 block">
                              {formatBugReportFileSize(screenshot.byteSize)}
                            </Text>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </div>
                ) : null}

                {selectedSummary && selectedSummary.logs.length > 0 ? (
                  <Card tone="default" radius="2xl" shadow="none" padding="sm">
                    <Text variant="bodyStrong">Raw log payload</Text>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl bg-slate-950 px-3 py-3 text-xs text-slate-100">
                      {JSON.stringify(selectedReport.logs, null, 2)}
                    </pre>
                  </Card>
                ) : null}
              </div>
            ) : (
              <Text variant="body" tone="secondary">Unable to load this report.</Text>
            )}
          </div>
        </div>
        <BugReportScreenshotModal
          isOpen={selectedScreenshot !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedScreenshotId(null);
            }
          }}
          src={selectedScreenshot ? buildScreenshotSrc(selectedScreenshot) : null}
          alt={selectedScreenshot?.fileName ?? "Screenshot"}
        />
      </div>
    </StudioDialogModal>
  );
}
