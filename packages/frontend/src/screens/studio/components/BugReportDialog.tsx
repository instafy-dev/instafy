import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from "react";
import { Camera, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Checkbox } from "../../../components/Checkbox";
import { Text } from "../../../components/Text";
import { Textarea } from "../../../components/Textarea";
import { StudioDialogBody, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { instafyBuildInfo } from "../../../config/buildInfo";
import type { BuildLogEntry } from "../../../types";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { collectAppReleaseMetadata } from "../../../updates/releaseMetadata";
import {
  assertBugReportScreenshotTotalBytes,
  buildBugReportScreenshotDrafts,
  buildBugReportScreenshotDraftFromDataUrl,
  BUG_REPORT_MAX_SCREENSHOTS,
  BUG_REPORT_MAX_SCREENSHOT_TOTAL_BYTES,
  BUG_REPORT_SCREENSHOT_ACCEPT,
  formatBugReportFileSize,
  isSupportedBugReportScreenshotMediaType,
  type BugReportScreenshotDraft,
} from "./bugReportDrafts";
import { BugReportScreenshotModal } from "./BugReportScreenshotModal";
import { sanitizeBugReportLocation } from "./bugReportDiagnostics";

const {
  submit: submitControllerBugReport,
  createRequestId: createControllerBugReportRequestId,
} = controllerClient.bugReports;

interface BugReportDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserId: string;
  isUserSessionCurrent: (expectedUserId: string) => boolean;
  initialMessage?: string;
  initialDetails?: string;
  initialScreenshots?: BugReportScreenshotDraft[];
  activeProjectId: string | null;
  activeConversationId: string | null;
  activeConversationLocalId?: string | null;
  activeRuntimeId: string | null;
  controllerProjectMissing: boolean;
  appLogs: BuildLogEntry[];
  buildLogs: BuildLogEntry[];
}

type BugReportSubmissionPayload = Parameters<typeof submitControllerBugReport>[0];

interface BugReportSubmissionAttempt {
  key: string;
  requestId: string;
  payload: BugReportSubmissionPayload;
}

function trimOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildInitialDescription(message?: string, details?: string): string {
  const normalizedMessage = trimOptional(message ?? "") ?? "";
  const normalizedDetails = trimOptional(details ?? "") ?? "";
  if (normalizedMessage && normalizedDetails) {
    if (normalizedDetails === normalizedMessage) {
      return normalizedDetails;
    }
    return `${normalizedMessage}\n\n${normalizedDetails}`;
  }
  return normalizedDetails || normalizedMessage;
}

function buildBugReportSummary(description: string): string {
  const firstLine = description
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?? description.trim();
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 120) {
    return collapsed;
  }
  return `${collapsed.slice(0, 117).trimEnd()}...`;
}

export function BugReportDialog({
  isOpen,
  onOpenChange,
  currentUserId,
  isUserSessionCurrent,
  initialMessage,
  initialDetails,
  initialScreenshots,
  activeProjectId,
  activeConversationId,
  activeConversationLocalId,
  activeRuntimeId,
  controllerProjectMissing,
  appLogs,
  buildLogs,
}: BugReportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const submissionAttemptsRef = useRef(new Map<string, BugReportSubmissionAttempt>());
  const submissionInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [description, setDescription] = useState(() => buildInitialDescription(initialMessage, initialDetails));
  const [screenshots, setScreenshots] = useState<BugReportScreenshotDraft[]>([]);
  const [selectedScreenshotId, setSelectedScreenshotId] = useState<string | null>(null);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { showStatus } = useStatus();

  useEffect(() => {
    // React StrictMode intentionally runs effect setup/cleanup/setup once in
    // development. Reassert the live state during setup so the second setup is
    // not mistaken for an unmounted dialog by asynchronous submission guards.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setDescription(buildInitialDescription(initialMessage, initialDetails));
    setScreenshots(initialScreenshots?.map((screenshot) => ({ ...screenshot })) ?? []);
    setSelectedScreenshotId(null);
    setIncludeDiagnostics(false);
    submissionAttemptsRef.current.clear();
  }, [initialDetails, initialMessage, initialScreenshots, isOpen]);

  useEffect(() => {
    return () => {
      screenshots.forEach((screenshot) => {
        if (screenshot.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(screenshot.previewUrl);
        }
      });
    };
  }, [screenshots]);

  const logSummary = useMemo(() => {
    return {
      app: appLogs.length,
      runtime: buildLogs.length,
    };
  }, [appLogs.length, buildLogs.length]);

  const attachFiles = useCallback(
    async (files: File[]) => {
      try {
        const drafts = await buildBugReportScreenshotDrafts(files, screenshots);
        setScreenshots((current) => [...current, ...drafts]);
      } catch (error) {
        const nextMessage = error instanceof Error ? error.message : "Unable to attach screenshot.";
        showStatus(nextMessage, "error", 3500);
      }
    },
    [screenshots, showStatus],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length > 0) {
        void attachFiles(files);
      }
      event.target.value = "";
    },
    [attachFiles],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement | HTMLInputElement | HTMLTextAreaElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }
      const imageFiles = Array.from(clipboardData.items ?? [])
        .filter(
          (item) =>
            item.kind === "file" &&
            isSupportedBugReportScreenshotMediaType(item.type),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file instanceof File);
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void attachFiles(imageFiles);
    },
    [attachFiles],
  );

  const handleRemoveScreenshot = useCallback((id: string) => {
    setScreenshots((current) => current.filter((draft) => draft.id !== id));
    setSelectedScreenshotId((current) => (current === id ? null : current));
  }, []);

  const selectedScreenshot = useMemo(
    () => screenshots.find((draft) => draft.id === selectedScreenshotId) ?? null,
    [screenshots, selectedScreenshotId],
  );

  const handleSaveAnnotatedScreenshot = useCallback(
    async (dataUrl: string) => {
      if (!selectedScreenshotId) {
        return;
      }
      try {
        const nextDraft = buildBugReportScreenshotDraftFromDataUrl(dataUrl, {
          fileName: screenshots.find((draft) => draft.id === selectedScreenshotId)?.fileName,
        });
        assertBugReportScreenshotTotalBytes(
          screenshots.reduce(
            (total, draft) =>
              total + (draft.id === selectedScreenshotId ? nextDraft.byteLength : draft.byteLength),
            0,
          ),
        );
        setScreenshots((current) =>
          current.map((draft) =>
            draft.id === selectedScreenshotId
              ? {
                  ...draft,
                  previewUrl: nextDraft.previewUrl,
                  mediaType: nextDraft.mediaType,
                  dataBase64: nextDraft.dataBase64,
                  byteLength: nextDraft.byteLength,
                }
              : draft,
          ),
        );
        showStatus("Screenshot markup saved.", "success", 2500);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to save screenshot markup.";
        showStatus(message, "error", 3500);
      }
    },
    [screenshots, selectedScreenshotId, showStatus],
  );

  const handleSubmit = useCallback(async () => {
    const normalizedDescription = trimOptional(description);
    if (!normalizedDescription) {
      showStatus("Add a short description before sending the report.", "error", 3500);
      return;
    }
    try {
      assertBugReportScreenshotTotalBytes(
        screenshots.reduce((total, screenshot) => total + screenshot.byteLength, 0),
      );
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "The screenshots are too large.",
        "error",
        3500,
      );
      return;
    }
    if (submissionInFlightRef.current) {
      return;
    }
    const submissionUserId = currentUserId;
    if (!isUserSessionCurrent(submissionUserId)) return;

    const reportScreenshots = screenshots.map((screenshot) => ({
      fileName: screenshot.fileName,
      mediaType: screenshot.mediaType,
      dataBase64: screenshot.dataBase64,
      byteLength: screenshot.byteLength,
    }));
    const reportLogs = includeDiagnostics ? [...appLogs, ...buildLogs] : [];
    const diagnosticMetadata = includeDiagnostics
      ? {
          location: sanitizeBugReportLocation(
            typeof window !== "undefined" ? window.location.href : null,
          ),
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          mode: import.meta.env.MODE,
          controllerProjectMissing,
          activeConversationLocalId,
          build: instafyBuildInfo,
        }
      : {};
    const basePayload = {
      message: buildBugReportSummary(normalizedDescription),
      details: normalizedDescription,
      projectId: activeProjectId,
      conversationId: activeConversationId,
      runtimeId: activeRuntimeId,
      metadata: diagnosticMetadata,
      logs: reportLogs,
      screenshots: reportScreenshots,
      expectedUserId: submissionUserId,
    } satisfies BugReportSubmissionPayload;
    // Keep background diagnostics out of the retry identity. Once an opted-in
    // upload may have reached the controller, a later render can contain new
    // app/runtime logs; that must retry the exact captured payload and UUID,
    // not create a second report merely because ambient logs advanced.
    const submissionKey = JSON.stringify({
      message: basePayload.message,
      details: basePayload.details,
      projectId: basePayload.projectId,
      conversationId: basePayload.conversationId,
      runtimeId: basePayload.runtimeId,
      screenshots: basePayload.screenshots,
      includeDiagnostics,
      expectedUserId: basePayload.expectedUserId,
    });

    submissionInFlightRef.current = true;
    setSubmitting(true);
    try {
      let attempt = submissionAttemptsRef.current.get(submissionKey);
      if (!attempt) {
        const releaseMetadata = includeDiagnostics
          ? await collectAppReleaseMetadata().catch(() => null)
          : null;
        if (!mountedRef.current || !isUserSessionCurrent(submissionUserId)) return;
        const payload: BugReportSubmissionPayload = {
          ...basePayload,
          metadata: includeDiagnostics
            ? { ...diagnosticMetadata, release: releaseMetadata }
            : {},
        };
        attempt = {
          key: submissionKey,
          requestId: createControllerBugReportRequestId(),
          payload,
        };
        submissionAttemptsRef.current.set(submissionKey, attempt);
      }

      const result = await submitControllerBugReport({
        ...attempt.payload,
        clientRequestId: attempt.requestId,
      });
      if (!mountedRef.current || !isUserSessionCurrent(submissionUserId)) return;
      if (submissionAttemptsRef.current.get(attempt.key)?.requestId === attempt.requestId) {
        submissionAttemptsRef.current.delete(attempt.key);
      }

      const submittedId = result?.id ?? "unknown";
      showStatus(`Issue report sent (${submittedId.slice(0, 8)}…).`, "success", 4000);
      onOpenChange(false);
    } catch (error) {
      if (!mountedRef.current || !isUserSessionCurrent(submissionUserId)) return;
      const nextMessage = error instanceof Error ? error.message : "Unable to submit issue report.";
      showStatus(nextMessage, "error", 4500);
    } finally {
      submissionInFlightRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    activeConversationId,
    activeConversationLocalId,
    activeProjectId,
    activeRuntimeId,
    appLogs,
    buildLogs,
    controllerProjectMissing,
    description,
    includeDiagnostics,
    currentUserId,
    isUserSessionCurrent,
    onOpenChange,
    screenshots,
    showStatus,
  ]);

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!submitting}
      dialogAriaLabel="Report issue"
      data-testid="bug-report-modal"
      modalClassName="max-w-2xl overflow-hidden p-0"
    >
      <div className="flex max-h-[min(90dvh,48rem)] flex-col overflow-hidden" data-bug-report-overlay="true">
        <StudioDialogHeader
          title="Report issue"
          description="Describe what broke and review what information will be shared with support."
          descriptionClassName="max-w-xl"
          onClose={() => onOpenChange(false)}
          closeLabel="Close issue report"
          closeButtonDisabled={submitting}
        />

        <StudioDialogBody className="flex-1 space-y-5 overflow-y-auto">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Text as="label" variant="caption" tone="secondary" className="font-medium" htmlFor="bug-report-description">
                Describe the issue
              </Text>
              <Button
                onPress={() => fileInputRef.current?.click()}
                variant="outline"
                size="sm"
                radius="full"
                className="shrink-0"
              >
                <Camera className="h-4 w-4" />
                Add screenshots
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={BUG_REPORT_SCREENSHOT_ACCEPT}
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
            <Text variant="caption" tone="secondary">
              Paste or attach up to {BUG_REPORT_MAX_SCREENSHOTS} PNG, JPEG, or WebP screenshots,
              up to 4 MB each and {BUG_REPORT_MAX_SCREENSHOT_TOTAL_BYTES / (1024 * 1024)} MB total.
            </Text>
            <Textarea
              id="bug-report-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onPaste={handlePaste}
              placeholder="What happened, what you expected, and any steps that help reproduce it."
              radius="2xl"
              rows={6}
              data-testid="bug-report-description"
            />
            <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
              <Text variant="caption" tone="secondary" data-testid="bug-report-screenshot-dropzone">
                Screenshots: {screenshots.length}/{BUG_REPORT_MAX_SCREENSHOTS}
              </Text>
            </div>
            {screenshots.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {screenshots.map((screenshot) => (
                  <Card key={screenshot.id} tone="default" radius="2xl" shadow="none" padding="sm" className="space-y-3">
                    <button
                      type="button"
                      className="block w-full overflow-hidden rounded-xl"
                      onClick={() => setSelectedScreenshotId(screenshot.id)}
                      aria-label={`Open ${screenshot.fileName} fullscreen`}
                    >
                      <img
                        src={screenshot.previewUrl}
                        alt={screenshot.fileName}
                        className="h-32 w-full rounded-xl object-cover transition-transform hover:scale-[1.01]"
                      />
                    </button>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Text variant="bodyStrong" className="truncate">
                          {screenshot.fileName}
                        </Text>
                        <Text variant="caption" tone="secondary" className="mt-1 block">
                          {formatBugReportFileSize(screenshot.byteLength)}
                        </Text>
                      </div>
                      <IconButton
                        onPress={() => handleRemoveScreenshot(screenshot.id)}
                        variant="ghost"
                        size="sm"
                        radius="full"
                        aria-label={`Remove ${screenshot.fileName}`}
                      >
                        <Xmark className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  </Card>
                ))}
              </div>
            ) : null}
            <Card tone="muted" radius="2xl" shadow="none" padding="sm" className="space-y-3">
              <div>
                <Text variant="bodyStrong">What will be sent</Text>
                <Text variant="caption" tone="secondary" className="mt-1 block">
                  Your description, the current space and conversation context, and only the screenshots shown above. Your signed-in identity and email are attached for ownership and support contact.
                </Text>
              </div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
                <Text variant="caption" tone="secondary">Space context: {activeProjectId ? "Included" : "None"}</Text>
                <Text variant="caption" tone="secondary">Conversation context: {activeConversationId ? "Included" : "None"}</Text>
                <Text variant="caption" tone="secondary">Runtime context: {activeRuntimeId ? "Included" : "None"}</Text>
              </div>
              <Checkbox
                isSelected={includeDiagnostics}
                onChange={setIncludeDiagnostics}
                label="Include diagnostics"
                description="Share app and runtime logs plus browser, build, release, and page-path information. This is off by default."
                data-testid="bug-report-include-diagnostics"
              />
              {includeDiagnostics ? (
                <Card tone="default" radius="xl" shadow="none" padding="sm" data-testid="bug-report-diagnostics-preview">
                  <Text variant="caption" tone="secondary" className="font-medium">Diagnostics preview</Text>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-300">
                    <li>{logSummary.app} app log entries and {logSummary.runtime} runtime log entries</li>
                    <li>App mode, build identifier, and release information</li>
                    <li>Browser or device user-agent information</li>
                    <li>
                      Page: {sanitizeBugReportLocation(typeof window !== "undefined" ? window.location.href : null) ?? "Unavailable"}
                    </li>
                  </ul>
                  <Text variant="caption" tone="muted" className="mt-2 block">
                    URL query parameters and fragments are removed. Your account email is used for ownership and contact, but is not duplicated inside optional diagnostics.
                  </Text>
                </Card>
              ) : null}
            </Card>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button
              onPress={() => onOpenChange(false)}
              variant="ghost"
              size="sm"
              radius="full"
              isDisabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onPress={handleSubmit}
              variant="primary"
              size="sm"
              radius="full"
              isDisabled={submitting}
              data-testid="bug-report-submit"
            >
              {submitting ? "Sending…" : "Send report"}
            </Button>
          </div>
        </StudioDialogBody>
      </div>
      <BugReportScreenshotModal
        isOpen={selectedScreenshot !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedScreenshotId(null);
          }
        }}
        src={selectedScreenshot?.previewUrl ?? null}
        alt={selectedScreenshot?.fileName ?? "Screenshot"}
        editable
        onSave={handleSaveAnnotatedScreenshot}
      />
    </StudioDialogModal>
  );
}
