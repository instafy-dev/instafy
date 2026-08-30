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
  buildBugReportScreenshotDrafts,
  buildBugReportScreenshotDraftFromDataUrl,
  BUG_REPORT_MAX_SCREENSHOTS,
  formatBugReportFileSize,
  type BugReportScreenshotDraft,
} from "./bugReportDrafts";
import { BugReportScreenshotModal } from "./BugReportScreenshotModal";

const { submit: submitControllerBugReport } = controllerClient.bugReports;

interface BugReportDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  initialMessage?: string;
  initialDetails?: string;
  initialScreenshots?: BugReportScreenshotDraft[];
  activeProjectId: string | null;
  activeConversationId: string | null;
  activeConversationLocalId?: string | null;
  activeRuntimeId: string | null;
  userEmail: string | null;
  controllerProjectMissing: boolean;
  appLogs: BuildLogEntry[];
  buildLogs: BuildLogEntry[];
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
  initialMessage,
  initialDetails,
  initialScreenshots,
  activeProjectId,
  activeConversationId,
  activeConversationLocalId,
  activeRuntimeId,
  userEmail,
  controllerProjectMissing,
  appLogs,
  buildLogs,
}: BugReportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [description, setDescription] = useState(() => buildInitialDescription(initialMessage, initialDetails));
  const [screenshots, setScreenshots] = useState<BugReportScreenshotDraft[]>([]);
  const [selectedScreenshotId, setSelectedScreenshotId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { showStatus } = useStatus();

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setDescription(buildInitialDescription(initialMessage, initialDetails));
    setScreenshots(initialScreenshots?.map((screenshot) => ({ ...screenshot })) ?? []);
    setSelectedScreenshotId(null);
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
        const drafts = await buildBugReportScreenshotDrafts(files, screenshots.length);
        setScreenshots((current) => [...current, ...drafts]);
      } catch (error) {
        const nextMessage = error instanceof Error ? error.message : "Unable to attach screenshot.";
        showStatus(nextMessage, "error", 3500);
      }
    },
    [screenshots.length, showStatus],
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
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
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

    setSubmitting(true);
    try {
      const releaseMetadata = await collectAppReleaseMetadata().catch(() => null);
      const metadata: Record<string, unknown> = {
        location: typeof window !== "undefined" ? window.location.href : null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        mode: import.meta.env.MODE,
        userEmail,
        controllerProjectMissing,
        screenshotCount: screenshots.length,
        activeConversationLocalId,
        build: instafyBuildInfo,
        release: releaseMetadata,
      };

      const result = await submitControllerBugReport({
        message: buildBugReportSummary(normalizedDescription),
        details: normalizedDescription,
        projectId: activeProjectId,
        conversationId: activeConversationId,
        runtimeId: activeRuntimeId,
        metadata,
        logs: [...appLogs, ...buildLogs],
        screenshots: screenshots.map((screenshot) => ({
          fileName: screenshot.fileName,
          mediaType: screenshot.mediaType,
          dataBase64: screenshot.dataBase64,
          byteLength: screenshot.byteLength,
        })),
      });

      const submittedId = result?.id ?? "unknown";
      showStatus(`Issue report sent (${submittedId.slice(0, 8)}…).`, "success", 4000);
      onOpenChange(false);
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : "Unable to submit issue report.";
      showStatus(nextMessage, "error", 4500);
    } finally {
      setSubmitting(false);
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
    onOpenChange,
    screenshots,
    showStatus,
    userEmail,
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
          description="Describe what broke. Space, conversation, runtime, logs, and build details are included automatically."
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
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
            <Text variant="caption" tone="secondary">
              Paste screenshots directly into this field, or attach up to {BUG_REPORT_MAX_SCREENSHOTS} images.
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
            <div className="grid grid-cols-1 gap-2 text-sm text-slate-600 dark:text-slate-300 sm:grid-cols-2">
              <Text variant="caption" tone="secondary">Space: {activeProjectId ? activeProjectId.slice(0, 8) : "None"}</Text>
              <Text variant="caption" tone="secondary">Conversation: {activeConversationId ? activeConversationId.slice(0, 8) : "None"}</Text>
              <Text variant="caption" tone="secondary">Runtime: {activeRuntimeId ? activeRuntimeId.slice(0, 8) : "None"}</Text>
              <Text variant="caption" tone="secondary">
                Logs: {logSummary.app} app · {logSummary.runtime} runtime
              </Text>
            </div>
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
