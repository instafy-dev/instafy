import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, Refresh } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import {
  controllerClient,
  type ControllerBugReportDetail,
  type ControllerBugReportSummary,
} from "../../../sdk/instafy";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { useStatus } from "../../../status/useStatus";

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

export function BugReportInboxDialog({ isOpen, onOpenChange }: BugReportInboxDialogProps) {
  const { showStatus } = useStatus();
  const [reports, setReports] = useState<ControllerBugReportSummary[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<ControllerBugReportDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const selectedSummary = useMemo(
    () => reports.find((report) => report.id === selectedReportId) ?? null,
    [reports, selectedReportId],
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
          description="Recent reports for this account. Diagnostic payloads remain private to support."
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
                        {report.screenshotCount > 0 ? `${report.screenshotCount} attachments` : "No attachments"}
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
                        showStatus("Bug report id copied.", "success", 2500, { presentation: "confirmation" });
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
                    <Text variant="caption" tone="secondary">
                      Attachments: {selectedSummary?.screenshotCount ?? 0}
                    </Text>
                  </div>
                </Card>

                {(selectedSummary?.screenshotCount ?? 0) > 0 ? (
                  <Card tone="default" radius="2xl" shadow="none" padding="sm">
                    <Text variant="bodyStrong">Attachments retained</Text>
                    <Text variant="body" tone="secondary" className="mt-2">
                      Attachment contents and diagnostic logs are available to authorized support
                      operators, but are not returned in the customer report view.
                    </Text>
                  </Card>
                ) : null}
              </div>
            ) : (
              <Text variant="body" tone="secondary">Unable to load this report.</Text>
            )}
          </div>
        </div>
      </div>
    </StudioDialogModal>
  );
}
