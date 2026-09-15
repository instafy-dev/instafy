import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ChatBubble, ClipboardCheck, Plus, Refresh, SendDiagonal } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { Textarea } from "../../../components/Textarea";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import {
  controllerClient,
  type ControllerBugReportDetail,
  type ControllerBugReportListCursor,
  type ControllerBugReportMessage,
  type ControllerBugReportMessageListCursor,
  type ControllerBugReportSummary,
} from "../../../sdk/instafy";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { useStatus } from "../../../status/useStatus";
import { NOTIFICATION_RECEIVED_EVENT } from "../../../notifications/notificationPresentation";

const {
  get: getControllerBugReport,
  acknowledgeActivity: acknowledgeControllerBugReportActivity,
  listPage: listControllerBugReportPage,
  listMessagePage: listControllerBugReportMessagePage,
  postMessage: postControllerBugReportMessage,
  createMessageRequestId: createControllerBugReportMessageRequestId,
} = controllerClient.bugReports;

const MAX_SUPPORT_MESSAGE_LENGTH = 4_000;

interface SupportReplyAttempt {
  reportId: string;
  body: string;
  draft: string;
  requestId: string;
  key: string;
}

interface BugReportInboxDialogProps {
  isOpen: boolean;
  currentUserId: string;
  isUserSessionCurrent: (expectedUserId: string) => boolean;
  initialReportRequest?: { reportId: string; requestKey: number } | null;
  onOpenChange: (open: boolean) => void;
  onReportIssue?: () => void;
  onSupportActivityAcknowledged?: () => void;
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

function normalizeStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "open":
      return "Received";
    case "in_progress":
      return "Investigating";
    case "waiting_for_customer":
      return "Waiting for you";
    case "resolved":
      return "Resolved";
    default:
      return status.replaceAll("_", " ");
  }
}

function messageLabel(message: ControllerBugReportMessage): string {
  if (message.authorType === "customer") {
    return "You";
  }
  if (message.authorType === "support") {
    return "Instafy Support";
  }
  return "Status update";
}

function replyAttemptKey(reportId: string, body: string): string {
  return JSON.stringify([reportId, body]);
}

function mergeById<T extends { id: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const result = [...existing];
  const indexById = new Map(result.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, result.length);
      result.push(item);
    } else {
      result[existingIndex] = item;
    }
  }
  return result;
}

export function BugReportInboxDialog({
  isOpen,
  currentUserId,
  isUserSessionCurrent,
  initialReportRequest = null,
  onOpenChange,
  onReportIssue,
  onSupportActivityAcknowledged,
}: BugReportInboxDialogProps) {
  const { showStatus } = useStatus();
  const initialReportId = initialReportRequest?.reportId ?? null;
  const initialReportRequestKey = initialReportRequest?.requestKey ?? null;
  const [reports, setReports] = useState<ControllerBugReportSummary[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<ControllerBugReportDetail | null>(null);
  const [messages, setMessages] = useState<ControllerBugReportMessage[]>([]);
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMoreReports, setLoadingMoreReports] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listPageError, setListPageError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesPageError, setMessagesPageError] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [detailRefreshEpoch, setDetailRefreshEpoch] = useState(0);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const [reportsHasMore, setReportsHasMore] = useState(false);
  const [reportsNextCursor, setReportsNextCursor] =
    useState<ControllerBugReportListCursor | null>(null);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [messagesNextCursor, setMessagesNextCursor] =
    useState<ControllerBugReportMessageListCursor | null>(null);
  const selectedReportIdRef = useRef<string | null>(selectedReportId);
  const replyRef = useRef(reply);
  const inFlightReplyRef = useRef<SupportReplyAttempt | null>(null);
  const retryRequestIdsRef = useRef(new Map<string, string>());
  const reportsRequestGenerationRef = useRef(0);
  const acknowledgementAttemptsRef = useRef(new Map<string, symbol>());
  const mountedRef = useRef(true);

  selectedReportIdRef.current = selectedReportId;
  replyRef.current = reply;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadReports = useCallback(async () => {
    const requestUserId = currentUserId;
    if (!isUserSessionCurrent(requestUserId)) return;
    const requestGeneration = ++reportsRequestGenerationRef.current;
    setLoading(true);
    setLoadingMoreReports(false);
    setListError(null);
    setListPageError(null);
    try {
      const page = await listControllerBugReportPage(50, null, requestUserId);
      if (
        requestGeneration !== reportsRequestGenerationRef.current ||
        !mountedRef.current ||
        !isUserSessionCurrent(requestUserId)
      ) return;
      const nextReports = page.reports;
      setReports(nextReports);
      setReportsHasMore(page.hasMore);
      setReportsNextCursor(page.nextCursor);
      setSelectedReportId((current) => {
        // Preserve an explicitly targeted report even when it is older than the
        // first list page. The owner-scoped detail request can still load it.
        const nextReportId = current ?? nextReports[0]?.id ?? null;
        selectedReportIdRef.current = nextReportId;
        return nextReportId;
      });
    } catch (error) {
      if (requestGeneration !== reportsRequestGenerationRef.current) return;
      const message = error instanceof Error ? error.message : "Unable to load support reports.";
      setListError(message);
    } finally {
      if (requestGeneration === reportsRequestGenerationRef.current) {
        setLoading(false);
        setLoadingMoreReports(false);
      }
    }
  }, [currentUserId, isUserSessionCurrent]);

  const loadMoreReports = useCallback(async () => {
    if (!reportsHasMore || !reportsNextCursor || loading || loadingMoreReports) {
      return;
    }
    const requestUserId = currentUserId;
    if (!isUserSessionCurrent(requestUserId)) return;
    const requestGeneration = ++reportsRequestGenerationRef.current;
    const cursor = reportsNextCursor;
    setLoadingMoreReports(true);
    setListPageError(null);
    try {
      const page = await listControllerBugReportPage(50, cursor, requestUserId);
      if (
        requestGeneration !== reportsRequestGenerationRef.current ||
        !mountedRef.current ||
        !isUserSessionCurrent(requestUserId)
      ) return;
      setReports((current) => mergeById(current, page.reports));
      setReportsHasMore(page.hasMore);
      setReportsNextCursor(page.nextCursor);
    } catch (error) {
      if (requestGeneration !== reportsRequestGenerationRef.current) return;
      setListPageError(
        error instanceof Error ? error.message : "Unable to load more support reports.",
      );
    } finally {
      if (requestGeneration === reportsRequestGenerationRef.current) {
        setLoadingMoreReports(false);
      }
    }
  }, [
    currentUserId,
    isUserSessionCurrent,
    loading,
    loadingMoreReports,
    reportsHasMore,
    reportsNextCursor,
  ]);

  useEffect(() => {
    if (!isOpen || !initialReportId) return;
    selectedReportIdRef.current = initialReportId;
    setSelectedReportId(initialReportId);
    // A toast can target the report that is already selected. The request nonce
    // still represents a deliberate request to reveal fresh resolution state,
    // so force the detail and visible timeline to reload even when React bails
    // out of setting the same selected ID.
    setDetailRefreshEpoch((current) => current + 1);
  }, [initialReportId, initialReportRequestKey, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadReports();
  }, [initialReportRequestKey, isOpen, loadReports]);

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setVisibilityEpoch((current) => current + 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isOpen]);

  useEffect(() => {
    replyRef.current = "";
    setReply("");
    setReplyError(null);
  }, [isOpen, selectedReportId]);

  useEffect(() => {
    if (!isOpen || !selectedReportId) {
      setSelectedReport(null);
      setMessages([]);
      setMessagesHasMore(false);
      setMessagesNextCursor(null);
      return;
    }
    let cancelled = false;
    const reportId = selectedReportId;
    setSelectedReport(null);
    setMessages([]);
    setDetailError(null);
    setMessagesError(null);
    setMessagesPageError(null);
    setMessagesHasMore(false);
    setMessagesNextCursor(null);
    setLoadingOlderMessages(false);
    setLoadingDetail(true);
    setLoadingMessages(true);

    void (async () => {
      // Snapshot the report cursor before loading the visible timeline. This
      // prevents acknowledging support activity newer than the messages the
      // customer actually received and rendered.
      try {
        const detail = await getControllerBugReport(reportId);
        if (!cancelled) setSelectedReport(detail);
      } catch (error) {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : "Unable to load this report.");
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
      if (cancelled) return;
      try {
        const page = await listControllerBugReportMessagePage(reportId);
        if (!cancelled) {
          setMessages(page.messages);
          setMessagesHasMore(page.hasMore);
          setMessagesNextCursor(page.nextCursor);
        }
      } catch (error) {
        if (!cancelled) {
          setMessagesError(
            error instanceof Error ? error.message : "Unable to load the support conversation.",
          );
        }
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [detailRefreshEpoch, isOpen, selectedReportId]);

  useEffect(() => {
    if (
      !isOpen ||
      !selectedReport ||
      selectedReport.id !== selectedReportId ||
      !selectedReport.supportLastMessageAt ||
      loadingMessages ||
      messagesError ||
      (typeof document !== "undefined" && document.visibilityState !== "visible")
    ) {
      return;
    }
    const reportId = selectedReport.id;
    const seenThrough = selectedReport.supportLastMessageAt;
    // A later page may expose previously unread replies after the source badge
    // cleared. Only actual loaded support rows and the shown resolution qualify.
    const messageIds = messages.filter(message => message.authorType === "support").map(message => message.id);
    const resolutionNotificationId = selectedReport.status === "resolved" ? selectedReport.resolutionNotificationId : null;
    const attemptKey = JSON.stringify([reportId, seenThrough, messageIds, resolutionNotificationId]);
    if (acknowledgementAttemptsRef.current.has(attemptKey)) return;
    const attempt = Symbol(attemptKey);
    acknowledgementAttemptsRef.current.set(attemptKey, attempt);
    const releaseAttempt = () => {
      if (acknowledgementAttemptsRef.current.get(attemptKey) === attempt) acknowledgementAttemptsRef.current.delete(attemptKey);
    };
    let cancelled = false;
    let completed = false;
    const isCurrent = () => !cancelled && isUserSessionCurrent(currentUserId) &&
      selectedReportIdRef.current === reportId && document.visibilityState === "visible";
    void (async () => {
      let result: Awaited<ReturnType<typeof acknowledgeControllerBugReportActivity>> | null = null;
      for (let offset = 0; offset < Math.max(1, messageIds.length); offset += 100) {
        if (!isCurrent()) return null;
        result = await acknowledgeControllerBugReportActivity(reportId, seenThrough, {
          messageIds: messageIds.slice(offset, offset + 100),
          resolutionNotificationId: offset === 0 ? resolutionNotificationId : null,
          expectedUserId: currentUserId,
          isCurrent,
        });
      }
      return result;
    })()
      .then((result) => {
        if (!result || !isCurrent()) {
          releaseAttempt();
          return;
        }
        completed = true;
        window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
        setSelectedReport((current) =>
          current?.id === reportId
            ? {
                ...current,
                hasUnreadSupportActivity: result.hasUnreadSupportActivity,
                hasUnreadResolution: result.hasUnreadResolution,
              }
            : current,
        );
        setReports((current) =>
          current.map((report) =>
            report.id === reportId
              ? {
                  ...report,
                  hasUnreadSupportActivity: result.hasUnreadSupportActivity,
                  hasUnreadResolution: result.hasUnreadResolution,
                }
              : report,
          ),
        );
        onSupportActivityAcknowledged?.();
        if (result.hasUnreadSupportActivity) {
          setDetailRefreshEpoch((current) => current + 1);
          void loadReports();
        }
      })
      .catch(() => {
        releaseAttempt();
      });
    return () => {
      cancelled = true;
      if (!completed) releaseAttempt();
    };
  }, [
    currentUserId,
    isUserSessionCurrent,
    isOpen,
    loadReports,
    messages,
    loadingMessages,
    messagesError,
    onSupportActivityAcknowledged,
    selectedReport,
    selectedReportId,
    visibilityEpoch,
  ]);

  const loadOlderMessages = useCallback(async () => {
    if (
      !selectedReportId ||
      !messagesHasMore ||
      !messagesNextCursor ||
      loadingOlderMessages
    ) {
      return;
    }
    const reportId = selectedReportId;
    const cursor = messagesNextCursor;
    setLoadingOlderMessages(true);
    setMessagesPageError(null);
    try {
      const page = await listControllerBugReportMessagePage(reportId, {
        limit: 100,
        before: cursor,
      });
      if (selectedReportIdRef.current !== reportId) {
        return;
      }
      setMessages((current) => mergeById(page.messages, current));
      setMessagesHasMore(page.hasMore);
      setMessagesNextCursor(page.nextCursor);
    } catch (error) {
      if (selectedReportIdRef.current === reportId) {
        setMessagesPageError(
          error instanceof Error ? error.message : "Unable to load older messages.",
        );
      }
    } finally {
      if (selectedReportIdRef.current === reportId) {
        setLoadingOlderMessages(false);
      }
    }
  }, [loadingOlderMessages, messagesHasMore, messagesNextCursor, selectedReportId]);

  const handleReportIssue = useCallback(() => {
    onOpenChange(false);
    onReportIssue?.();
  }, [onOpenChange, onReportIssue]);

  const handleSendReply = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const normalizedReply = reply.trim();
      if (!selectedReportId || !normalizedReply || inFlightReplyRef.current) {
        return;
      }
      const submissionUserId = currentUserId;
      if (!isUserSessionCurrent(submissionUserId)) return;
      if (Array.from(normalizedReply).length > MAX_SUPPORT_MESSAGE_LENGTH) {
        setReplyError(
          `Support messages must be ${MAX_SUPPORT_MESSAGE_LENGTH.toLocaleString()} characters or shorter.`,
        );
        return;
      }

      const key = replyAttemptKey(selectedReportId, normalizedReply);
      const requestId =
        retryRequestIdsRef.current.get(key) ?? createControllerBugReportMessageRequestId();
      retryRequestIdsRef.current.set(key, requestId);
      const attempt: SupportReplyAttempt = {
        reportId: selectedReportId,
        body: normalizedReply,
        draft: reply,
        requestId,
        key,
      };
      inFlightReplyRef.current = attempt;
      setSendingReply(true);
      setReplyError(null);
      try {
        const message = await postControllerBugReportMessage(
          attempt.reportId,
          attempt.body,
          attempt.requestId,
        );
        if (!mountedRef.current || !isUserSessionCurrent(submissionUserId)) return;
        if (retryRequestIdsRef.current.get(attempt.key) === attempt.requestId) {
          retryRequestIdsRef.current.delete(attempt.key);
        }
        if (selectedReportIdRef.current !== attempt.reportId) {
          return;
        }
        setMessages((current) =>
          current.some((entry) => entry.id === message.id) ? current : [...current, message],
        );
        setReports((current) =>
          current.map((report) =>
            report.id === attempt.reportId
              ? { ...report, customerLastMessageAt: message.createdAt ?? report.customerLastMessageAt }
              : report,
          ),
        );
        if (replyRef.current === attempt.draft) {
          replyRef.current = "";
          setReply("");
        }
        showStatus("Message sent to Instafy Support.", "success", 2500, {
          presentation: "confirmation",
        });
        setDetailRefreshEpoch((current) => current + 1);
        void loadReports();
      } catch (error) {
        if (
          mountedRef.current &&
          isUserSessionCurrent(submissionUserId) &&
          selectedReportIdRef.current === attempt.reportId &&
          replyRef.current === attempt.draft
        ) {
          setReplyError(error instanceof Error ? error.message : "Unable to send your message.");
        }
      } finally {
        if (
          mountedRef.current &&
          isUserSessionCurrent(submissionUserId) &&
          inFlightReplyRef.current === attempt
        ) {
          inFlightReplyRef.current = null;
          setSendingReply(false);
        }
      }
    },
    [currentUserId, isUserSessionCurrent, loadReports, reply, selectedReportId, showStatus],
  );

  const handleRefresh = useCallback(() => {
    void loadReports();
    setDetailRefreshEpoch((current) => current + 1);
  }, [loadReports]);

  const normalizedReply = reply.trim();
  const replyCharacterCount = Array.from(normalizedReply).length;
  const replyTooLong = replyCharacterCount > MAX_SUPPORT_MESSAGE_LENGTH;

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!sendingReply}
      dialogAriaLabel="Support"
      data-testid="bug-report-inbox-modal"
      modalClassName="overflow-hidden p-0"
      modalStyle={{ maxWidth: "72rem" }}
    >
      <div className="flex max-h-[min(92dvh,56rem)] flex-col overflow-hidden" data-bug-report-overlay="true">
        <StudioDialogHeader
          title="Support"
          description="Your private support reports across all spaces. Only you and authorized support can see them."
          className="shrink-0"
          onClose={() => onOpenChange(false)}
          closeLabel="Close support"
          closeButtonDisabled={sendingReply}
        />
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200/70 px-5 py-3 dark:border-[color:var(--color-studio-dark-divider)]"
          role="group"
          aria-label="Support actions"
        >
          {onReportIssue ? (
            <Button
              onPress={handleReportIssue}
              variant="primary"
              size="sm"
              radius="full"
              data-testid="support-new-report"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Report an issue
            </Button>
          ) : null}
          <Button
            onPress={handleRefresh}
            variant="outline"
            size="sm"
            radius="full"
            isDisabled={loading || loadingMoreReports}
            aria-label="Refresh support reports"
          >
            <Refresh className="h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[21rem_minmax(0,1fr)]">
          <div className="overflow-y-auto border-b border-slate-200/70 p-3 dark:border-slate-800 lg:border-b-0 lg:border-r">
            {listError ? (
              <Card tone="danger" radius="2xl" shadow="none" padding="sm" role="alert">
                <Text variant="bodyStrong">Couldn’t load support</Text>
                <Text variant="caption" tone="secondary" className="mt-1 block">{listError}</Text>
                <Button onPress={() => void loadReports()} variant="outline" size="sm" radius="full" className="mt-3">
                  Try again
                </Button>
              </Card>
            ) : loading && reports.length === 0 ? (
              <Text variant="body" tone="secondary" role="status">Loading support reports…</Text>
            ) : reports.length === 0 ? (
              <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                <Text variant="bodyStrong">No support reports yet</Text>
                <Text variant="caption" tone="secondary" className="mt-1 block">
                  Report an issue when something isn’t working as expected.
                </Text>
                {onReportIssue ? (
                  <Button onPress={handleReportIssue} variant="outline" size="sm" radius="full" className="mt-3">
                    Report an issue
                  </Button>
                ) : null}
              </Card>
            ) : (
              <div className="space-y-2" role="list" aria-label="Your support reports">
                {reports.map((report) => {
                  const selected = report.id === selectedReportId;
                  return (
                    <div key={report.id} role="listitem">
                      <button
                        type="button"
                        className="block w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                        onClick={() => {
                          selectedReportIdRef.current = report.id;
                          setSelectedReportId(report.id);
                        }}
                        aria-pressed={selected}
                      >
                        <Card
                          tone={selected ? "success" : "default"}
                          radius="2xl"
                          shadow="none"
                          padding="sm"
                          className="transition-colors hover:bg-slate-50 dark:hover:bg-[var(--color-studio-dark-panel-soft)]"
                          data-testid={selected ? "bug-report-inbox-selected" : undefined}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-start gap-2">
                                {report.hasUnreadSupportActivity ? (
                                  <span
                                    className="mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-sky-500"
                                    data-testid="support-report-unread-indicator"
                                    aria-label="Unread support update"
                                    title="Unread support update"
                                  />
                                ) : null}
                                <Text variant="bodyStrong" className="line-clamp-2">
                                  {report.message}
                                </Text>
                              </div>
                              <Text variant="caption" tone="secondary" className="mt-1 block">
                                {formatBugReportTimestamp(
                                  report.activityAt ?? report.updatedAt ?? report.createdAt,
                                )}
                              </Text>
                            </div>
                            <Badge
                              size="xs"
                              tone={
                                report.status === "resolved"
                                  ? "success"
                                  : report.status === "waiting_for_customer"
                                    ? "warning"
                                    : "neutral"
                              }
                            >
                              {normalizeStatus(report.status)}
                            </Badge>
                          </div>
                          {report.screenshotCount > 0 ? (
                            <Text variant="caption" tone="muted" className="mt-2 block">
                              {report.screenshotCount} attachment{report.screenshotCount === 1 ? "" : "s"}
                            </Text>
                          ) : null}
                        </Card>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {listPageError ? (
              <Card
                tone="danger"
                radius="2xl"
                shadow="none"
                padding="sm"
                role="alert"
                className="mt-3"
              >
                <Text variant="caption">{listPageError}</Text>
              </Card>
            ) : null}
            {reportsHasMore && reportsNextCursor ? (
              <Button
                onPress={() => void loadMoreReports()}
                variant="outline"
                size="sm"
                radius="full"
                className="mt-3 w-full"
                isDisabled={loadingMoreReports}
              >
                {loadingMoreReports ? "Loading more reports…" : "Load more reports"}
              </Button>
            ) : null}
          </div>

          <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
            {!selectedReportId ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center text-center">
                <ChatBubble className="h-8 w-8 text-slate-400" aria-hidden="true" />
                <Text variant="body" tone="secondary" className="mt-3">Select a report to open its conversation.</Text>
              </div>
            ) : loadingDetail && !selectedReport ? (
              <Text variant="body" tone="secondary" role="status">Loading report…</Text>
            ) : detailError ? (
              <Card tone="danger" radius="2xl" shadow="none" padding="sm" role="alert">
                <Text variant="bodyStrong">Couldn’t open this report</Text>
                <Text variant="caption" tone="secondary" className="mt-1 block">{detailError}</Text>
                <Button onPress={() => setDetailRefreshEpoch((current) => current + 1)} variant="outline" size="sm" radius="full" className="mt-3">
                  Try again
                </Button>
              </Card>
            ) : selectedReport ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge
                        size="xs"
                        tone={selectedReport.status === "resolved" ? "success" : "neutral"}
                        data-testid="support-report-detail-status"
                      >
                        {normalizeStatus(selectedReport.status)}
                      </Badge>
                      <Text variant="caption" tone="secondary">
                        Activity {formatBugReportTimestamp(
                          selectedReport.activityAt ??
                            selectedReport.updatedAt ??
                            selectedReport.createdAt,
                        )}
                      </Text>
                    </div>
                    <Heading level={3}>{selectedReport.message}</Heading>
                  </div>
                  <Button
                    onPress={async () => {
                      const copyUserId = currentUserId;
                      if (!isUserSessionCurrent(copyUserId)) return;
                      try {
                        await writeClipboardText(selectedReport.id);
                        if (!mountedRef.current || !isUserSessionCurrent(copyUserId)) return;
                        showStatus("Support report id copied.", "success", 2500, { presentation: "confirmation" });
                      } catch (error) {
                        if (!mountedRef.current || !isUserSessionCurrent(copyUserId)) return;
                        showStatus(
                          error instanceof Error ? error.message : "Unable to copy support report id.",
                          "error",
                          3500,
                        );
                      }
                    }}
                    variant="outline"
                    size="sm"
                    radius="full"
                  >
                    <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
                    Copy id
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="caption" tone="secondary">Support contact</Text>
                    <Text variant="bodyStrong" className="mt-1">Instafy Support</Text>
                  </Card>
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="caption" tone="secondary">Space context</Text>
                    <Text variant="bodyStrong" className="mt-1">
                      {selectedReport.projectId ? "Included" : "Not included"}
                    </Text>
                  </Card>
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="caption" tone="secondary">Attachments</Text>
                    <Text variant="bodyStrong" className="mt-1">{selectedReport.screenshots.length}</Text>
                  </Card>
                </div>

                <section aria-labelledby="support-conversation-title" className="space-y-3">
                  <div>
                    <Heading level={4} id="support-conversation-title">Conversation</Heading>
                    <Text variant="caption" tone="secondary" className="mt-1 block">
                      Replies shared here come from Instafy Support. Private investigation details, files, and runtime access stay internal.
                    </Text>
                  </div>

                  {messagesHasMore && messagesNextCursor ? (
                    <Button
                      onPress={() => void loadOlderMessages()}
                      variant="outline"
                      size="sm"
                      radius="full"
                      isDisabled={loadingOlderMessages}
                    >
                      {loadingOlderMessages ? "Loading older messages…" : "Load older messages"}
                    </Button>
                  ) : null}
                  {messagesPageError ? (
                    <Card tone="danger" radius="2xl" shadow="none" padding="sm" role="alert">
                      <Text variant="caption">{messagesPageError}</Text>
                    </Card>
                  ) : null}

                  <ol className="space-y-3" aria-live="polite" data-testid="support-message-timeline">
                    <li className="flex justify-end">
                      <Card tone="success" radius="2xl" shadow="none" padding="sm" className="max-w-[92%] sm:max-w-[80%]">
                        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                          <Text variant="caption" tone="secondary">You · Original report</Text>
                          <Text variant="caption" tone="muted">{formatBugReportTimestamp(selectedReport.createdAt)}</Text>
                        </div>
                        <Text
                          variant="body"
                          className="mt-2 whitespace-pre-wrap break-words [unicode-bidi:plaintext]"
                        >
                          {selectedReport.details ?? selectedReport.message}
                        </Text>
                      </Card>
                    </li>
                    {messages.map((message) => (
                      <li
                        key={message.id}
                        className={
                          message.authorType === "customer"
                            ? "flex justify-end"
                            : message.authorType === "support"
                              ? "flex justify-start"
                              : "flex justify-center"
                        }
                      >
                        <Card
                          tone={message.authorType === "customer" ? "success" : message.authorType === "system" ? "muted" : "default"}
                          radius="2xl"
                          shadow="none"
                          padding="sm"
                          className={message.authorType === "system" ? "max-w-[92%] text-center" : "max-w-[92%] sm:max-w-[80%]"}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                            <Text variant="caption" tone="secondary">{messageLabel(message)}</Text>
                            <Text variant="caption" tone="muted">{formatBugReportTimestamp(message.createdAt)}</Text>
                          </div>
                          <Text
                            variant="body"
                            className="mt-2 whitespace-pre-wrap break-words [unicode-bidi:plaintext]"
                          >
                            {message.body}
                          </Text>
                        </Card>
                      </li>
                    ))}
                  </ol>

                  {loadingMessages ? (
                    <Text variant="caption" tone="secondary" role="status">Loading conversation…</Text>
                  ) : null}
                  {messagesError ? (
                    <Card tone="danger" radius="2xl" shadow="none" padding="sm" role="alert">
                      <Text variant="caption">{messagesError}</Text>
                      <Button onPress={() => setDetailRefreshEpoch((current) => current + 1)} variant="outline" size="sm" radius="full" className="mt-2">
                        Retry conversation
                      </Button>
                    </Card>
                  ) : null}

                  <form onSubmit={(event) => void handleSendReply(event)} className="space-y-2">
                    <Text as="label" htmlFor="support-reply" variant="caption" tone="secondary" className="font-medium">
                      Follow up with support
                    </Text>
                    <Textarea
                      id="support-reply"
                      value={reply}
                      onChange={(event) => {
                        replyRef.current = event.target.value;
                        setReply(event.target.value);
                        setReplyError(null);
                      }}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          void handleSendReply();
                        }
                      }}
                      rows={3}
                      placeholder="Add details, answer a question, or tell support if the issue came back."
                      radius="2xl"
                      aria-invalid={replyError || replyTooLong ? "true" : undefined}
                      aria-describedby={replyError ? "support-reply-error" : "support-reply-hint"}
                      data-testid="support-reply"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        {replyError ? (
                          <Text id="support-reply-error" variant="caption" tone="danger" role="alert">{replyError}</Text>
                        ) : (
                          <Text id="support-reply-hint" variant="caption" tone="muted">
                            {replyCharacterCount.toLocaleString()} / {MAX_SUPPORT_MESSAGE_LENGTH.toLocaleString()} characters. Press {typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter to send.
                          </Text>
                        )}
                      </div>
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        radius="full"
                        isDisabled={
                          sendingReply ||
                          normalizedReply.length === 0 ||
                          replyTooLong ||
                          loadingMessages
                        }
                        data-testid="support-reply-submit"
                      >
                        <SendDiagonal className="h-4 w-4" aria-hidden="true" />
                        {sendingReply ? "Sending…" : selectedReport.status === "resolved" ? "Reply and reopen" : "Send message"}
                      </Button>
                    </div>
                  </form>
                </section>

                {selectedReport.screenshots.length > 0 ? (
                  <Card tone="muted" radius="2xl" shadow="none" padding="sm">
                    <Text variant="bodyStrong">Retained attachments</Text>
                    <Text variant="body" tone="secondary" className="mt-1">
                      Support retained {selectedReport.screenshots.length} attachment{selectedReport.screenshots.length === 1 ? "" : "s"}. Their contents and any opted-in diagnostic logs are not returned to this view.
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
