import { useCallback, useEffect, useId, useRef, useState, type FocusEvent } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { controllerClient } from "../../../sdk/instafy";
import { focusWasLost, restoreLostFocus } from "./historyFocus";
import {
  conflictedOnComputerCopy,
  DESKTOP_NO_CHANGES_COPY,
  DESKTOP_NOTHING_TO_SAVE_COPY,
  DESKTOP_SAVE_MESSAGE,
  DESKTOP_STATUS_ERROR_COPY,
  desktopChangesLabel,
  desktopSaveFailureCopy,
  desktopSavedCopy,
  keptOnComputerCopy,
  type HistoryNotice,
} from "./versioningCopy";

const LEASE_RETRY_DELAY_MS = 1_500;

type LineShape = "hidden" | "line" | "error";

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
  onFocusFallback,
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
  /** Focus a stable place when the line hides under the keyboard. */
  onFocusFallback?: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const checkSeqRef = useRef(0);
  const countRef = useRef<number | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const labelId = useId();
  const focusFallbackRef = useRef(onFocusFallback);
  focusFallbackRef.current = onFocusFallback;

  /** Resolves to the count it showed, or null when this check was dropped or failed. */
  const check = useCallback(async (): Promise<number | null> => {
    const seq = ++checkSeqRef.current;
    const status = await controllerClient.workspace.git
      .fetchStatus({ projectId, originId, routing: "default", limit: 1 })
      .catch(() => null);
    if (seq !== checkSeqRef.current) {
      return null;
    }
    if (status?.busy) {
      return null;
    }
    if (!status || (status.supported && status.error)) {
      setStatusFailed(true);
      return null;
    }
    setStatusFailed(false);
    const next = status.supported
      ? Math.max(0, typeof status.dirtyCount === "number" ? status.dirtyCount : status.dirtyPaths.length)
      : 0;
    countRef.current = next;
    setCount(next);
    return next;
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
      const result = await controllerClient.workspace.git
        .syncToRemote({
          projectId,
          originId,
          routing: "default",
          message: DESKTOP_SAVE_MESSAGE,
          leaseConflictRetryDelayMs: LEASE_RETRY_DELAY_MS,
        })
        .catch(() => null);
      if (!result?.ok) {
        // A refusal can still change the folder (not_saved commits the files
        // locally before the push fails): the count below is checked again.
        onNotice({ tone: "error", text: desktopSaveFailureCopy(result?.errorInfo ?? null) });
      } else {
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
      }
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
    // Whatever the answer: the line shows what the folder holds now.
    await check();
  }, [canWrite, check, onBusyChange, onCommitted, onNotice, originId, projectId, saving]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    const next = await check();
    setRetrying(false);
    if (next === 0) {
      // The error row goes away and nothing takes its place: say why.
      onNotice({ tone: "info", text: DESKTOP_NO_CHANGES_COPY });
    }
  }, [check, onNotice]);

  // Keyboard focus inside the line or its error row. Removing the focused
  // button may or may not fire blur, so only a move to another element clears it.
  const hadFocusRef = useRef(false);
  const handleFocus = useCallback(() => {
    hadFocusRef.current = true;
  }, []);
  const handleBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) {
      hadFocusRef.current = false;
    }
  }, []);

  // Whichever check changes the shape (the save's own, the drawer's, a
  // Retry), the control that had focus is gone with the old shape: the line
  // takes it to Save as version, the error row to Retry, and a hidden line
  // to the drawer's fallback (the Saved versions heading).
  const shape: LineShape = statusFailed ? "error" : count ? "line" : "hidden";
  const shapeRef = useRef<LineShape>("hidden");
  useEffect(() => {
    const previous = shapeRef.current;
    shapeRef.current = shape;
    if (previous === shape || previous === "hidden" || !hadFocusRef.current) {
      return;
    }
    if (shape === "line") {
      restoreLostFocus(saveRef.current);
    } else if (shape === "error") {
      restoreLostFocus(retryRef.current);
    } else {
      hadFocusRef.current = false;
      if (focusWasLost()) {
        focusFallbackRef.current?.();
      }
    }
  }, [shape]);

  if (shape === "error") {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5"
        data-testid="desktop-changes-error"
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        <Text as="span" variant="body" tone="muted">
          {DESKTOP_STATUS_ERROR_COPY}
        </Text>
        <Button
          ref={retryRef}
          variant="ghost"
          size="xs"
          radius="xl"
          onPress={() => void handleRetry()}
          isPending={retrying}
          data-testid="desktop-changes-retry"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (shape === "hidden" || !count) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5"
      data-testid="desktop-changes-line"
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <Text as="span" id={labelId} variant="body" tone="secondary">
        {desktopChangesLabel(count)}
      </Text>
      <Button
        ref={saveRef}
        variant="outline"
        size="sm"
        radius="xl"
        aria-describedby={labelId}
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
