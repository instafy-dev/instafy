import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogBody, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import {
  buildReleaseMetadataDetailRows,
  summarizeAppUpdateState,
  type AppReleaseMetadata,
} from "../../../updates/releaseMetadata";

interface UpdateStatusDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  metadata: AppReleaseMetadata | null;
  showDetails: boolean;
  onShowDetailsChange: (next: boolean) => void;
  onPrimaryAction: () => void;
  actionPending?: boolean;
}

function primaryActionLabel(metadata: AppReleaseMetadata | null): string {
  if (!metadata) {
    return "Check now";
  }
  switch (metadata.updates.primary_action) {
    case "download":
      return "Download update";
    case "install":
      return "Restart to update";
    case "check":
    default:
      return "Check now";
  }
}

function pendingPrimaryActionLabel(metadata: AppReleaseMetadata | null): string {
  if (!metadata) {
    return "Working…";
  }
  switch (metadata.updates.primary_action) {
    case "download":
      return "Downloading…";
    case "install":
      return "Restarting…";
    case "check":
    default:
      return "Checking…";
  }
}

function isPrimaryActionDisabled(metadata: AppReleaseMetadata | null, pending: boolean): boolean {
  if (pending || !metadata) {
    return pending;
  }
  return metadata.updates.primary_action === null;
}

function inlineDownloadErrorMessage(metadata: AppReleaseMetadata | null): string | null {
  const lastError = metadata?.updates.last_error?.trim();
  if (!lastError) {
    return null;
  }
  if (metadata?.updates.primary_action !== "download") {
    return null;
  }
  return `Last download failed: ${lastError} Try again.`;
}

export function formatAvailableUpdateVersion(metadata: AppReleaseMetadata): string | null {
  const availableVersion = metadata.updates.available_version;
  if (!availableVersion) {
    return null;
  }
  return metadata.runtime_surface === "desktop"
    ? `Available desktop version: ${availableVersion}`
    : `Available OTA: ${availableVersion}`;
}

export function UpdateStatusDialog({
  isOpen,
  onOpenChange,
  metadata,
  showDetails,
  onShowDetailsChange,
  onPrimaryAction,
  actionPending = false,
}: UpdateStatusDialogProps) {
  const summary = metadata ? summarizeAppUpdateState(metadata) : null;
  const detailRows = metadata ? buildReleaseMetadataDetailRows(metadata) : [];
  const downloadErrorMessage = inlineDownloadErrorMessage(metadata);
  const availableVersion = metadata ? formatAvailableUpdateVersion(metadata) : null;

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      dialogAriaLabel="App updates"
      isDismissable={!actionPending}
      modalClassName="max-w-md overflow-hidden p-0"
    >
      <StudioDialogHeader
        title="App updates"
        description={summary?.title ?? "Updates"}
        onClose={() => onOpenChange(false)}
        closeLabel="Close updates dialog"
        closeButtonDisabled={actionPending}
      />

      <StudioDialogBody className="space-y-4">
        {metadata ? (
          <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Text variant="bodyStrong">Installed app</Text>
                <Text variant="caption" tone="secondary" className="block break-words">
                  {metadata.binary.version || metadata.binary.label}
                  {metadata.binary.version && metadata.binary.label
                    ? ` · ${metadata.binary.label}`
                    : ""}
                </Text>
              </div>
              {availableVersion ? (
                <Text
                  variant="caption"
                  tone="secondary"
                  className="max-w-full break-all sm:max-w-[13rem] sm:text-right"
                >
                  {availableVersion}
                </Text>
              ) : null}
            </div>
            {showDetails ? (
              <dl className="space-y-2 border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
                {detailRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <Text as="dt" variant="caption" tone="secondary">
                      {row.label}
                    </Text>
                    <Text
                      as="dd"
                      variant="caption"
                      tone="primary"
                      className="max-w-full break-words text-left sm:max-w-[16rem] sm:text-right"
                    >
                      {row.value}
                    </Text>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : (
          <Text variant="caption" tone="secondary">
            Update status is unavailable right now.
          </Text>
        )}

        {actionPending && metadata?.updates.primary_action === "download" ? (
          <Text variant="caption" tone="secondary">
            Downloading the update in the background. This can take a minute on slower connections.
          </Text>
        ) : null}

        {!actionPending && downloadErrorMessage ? (
          <Text variant="caption" tone="danger">
            {downloadErrorMessage}
          </Text>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button
            onPress={() => onShowDetailsChange(!showDetails)}
            variant="ghost"
            size="sm"
            radius="full"
          >
            {showDetails ? "Hide details" : "Show details"}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              onPress={() => onOpenChange(false)}
              variant="ghost"
              size="sm"
              radius="full"
              isDisabled={actionPending}
            >
              Close
            </Button>
            <Button
              onPress={onPrimaryAction}
              variant="primary"
              size="sm"
              radius="full"
              isDisabled={isPrimaryActionDisabled(metadata, actionPending)}
            >
              {actionPending ? pendingPrimaryActionLabel(metadata) : primaryActionLabel(metadata)}
            </Button>
          </div>
        </div>
      </StudioDialogBody>
    </StudioDialogModal>
  );
}
