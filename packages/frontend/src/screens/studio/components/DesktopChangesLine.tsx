import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { controllerClient } from "../../../sdk/instafy";
import {
  conflictedOnComputerCopy,
  DESKTOP_NOTHING_TO_SAVE_COPY,
  DESKTOP_SAVE_MESSAGE,
  DESKTOP_STATUS_ERROR_COPY,
  desktopChangesLabel,
  desktopSaveFailureCopy,
  desktopSavedCopy,
  keptOnComputerCopy,
  type HistoryNotice,
} from "./historyCopy";

const LEASE_RETRY_DELAY_MS = 1_500;

/**
 * Desktop only: files changed in the folder outside Studio, with one action
 * that saves them as a version. The count comes from `/git/status` when the
 * drawer opens and after each action; nothing polls. Hidden at zero.
 */
export function DesktopChangesLine({
  projectId,
  originId,
  canWrite,
  disabled,
  refreshKey,
  onBusyChange,
  onNotice,
  onCommitted,
}: {
  projectId: string;
  originId: string;
  canWrite: boolean;
  /** Another History action is running. */
  disabled: boolean;
  /** Bumped by the drawer after each action. */
  refreshKey: number;
  onBusyChange: (busy: boolean) => void;
  onNotice: (notice: HistoryNotice) => void;
  onCommitted: (rev: string | null) => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const checkSeqRef = useRef(0);
  const countRef = useRef<number | null>(null);

  const check = useCallback(async () => {
    const seq = ++checkSeqRef.current;
    const status = await controllerClient.workspace.git
      .fetchStatus({ projectId, originId, routing: "default", limit: 1 })
      .catch(() => null);
    if (seq !== checkSeqRef.current) {
      return;
    }
    if (status?.busy) {
      return;
    }
    if (!status || (status.supported && status.error)) {
      setStatusFailed(true);
      return;
    }
    setStatusFailed(false);
    const next = status.supported
      ? Math.max(0, typeof status.dirtyCount === "number" ? status.dirtyCount : status.dirtyPaths.length)
      : 0;
    countRef.current = next;
    setCount(next);
  }, [originId, projectId]);

  useEffect(() => {
    void check();
  }, [check, refreshKey]);

  const handleSave = useCallback(async () => {
    if (!canWrite || saving) {
      return;
    }
    const shown = countRef.current ?? 0;
    setSaving(true);
    onBusyChange(true);
    try {
      const result = await controllerClient.workspace.git.syncToRemote({
        projectId,
        originId,
        routing: "default",
        message: DESKTOP_SAVE_MESSAGE,
        leaseConflictRetryDelayMs: LEASE_RETRY_DELAY_MS,
      });
      if (!result?.ok) {
        onNotice({ tone: "error", text: desktopSaveFailureCopy(result?.errorInfo ?? null) });
        return;
      }
      const conflicted = result.report?.conflictedPaths ?? [];
      const rejected = result.report?.rejectedPaths ?? [];
      const savedCount = Math.max(0, shown - conflicted.length - rejected.length);
      const sentences: string[] = [];
      if (savedCount > 0 && result.committed !== false) {
        sentences.push(desktopSavedCopy(savedCount));
      }
      if (conflicted.length > 0) {
        sentences.push(conflictedOnComputerCopy(conflicted));
      }
      sentences.push(...keptOnComputerCopy(rejected));
      if (sentences.length === 0) {
        sentences.push(DESKTOP_NOTHING_TO_SAVE_COPY);
      }
      onNotice({
        tone: conflicted.length > 0 || rejected.length > 0 ? "warning" : "success",
        text: sentences.join(" "),
      });
      if (result.committed !== false) {
        onCommitted(result.rev ?? null);
      }
    } finally {
      setSaving(false);
      onBusyChange(false);
      void check();
    }
  }, [canWrite, check, onBusyChange, onCommitted, onNotice, originId, projectId, saving]);

  if (statusFailed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5" data-testid="desktop-changes-error">
        <Text as="span" variant="body" tone="muted">
          {DESKTOP_STATUS_ERROR_COPY}
        </Text>
        <Button variant="ghost" size="xs" radius="xl" onPress={() => void check()} data-testid="desktop-changes-retry">
          Retry
        </Button>
      </div>
    );
  }

  if (!count) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5" data-testid="desktop-changes-line">
      <Text as="span" variant="body" tone="secondary">
        {desktopChangesLabel(count)}
      </Text>
      <Button
        variant="outline"
        size="sm"
        radius="xl"
        onPress={() => void handleSave()}
        isPending={saving}
        isDisabled={!canWrite || (disabled && !saving)}
        data-testid="desktop-save-as-version"
      >
        Save as version
      </Button>
    </div>
  );
}
