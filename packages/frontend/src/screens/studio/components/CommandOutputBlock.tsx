import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Eye, NavArrowRight, Terminal, Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { useStatus } from "../../../status/useStatus";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";

const RUNNING_STATUSES = new Set([
  "in_progress",
  "queued",
  "started",
  "running",
  "applying",
  "refreshing",
]);

const COLLAPSED_TAIL_CHARS = 3_200;
// Body-only mode caps the visible tail at this many lines until the reader
// asks for the rest; a terminal shows its tail, and so does a streaming run.
export const COMMAND_OUTPUT_BODY_LINE_CAP = 12;

type OutputWindow = {
  text: string;
  omittedChars: number;
  mode: "full" | "tail";
};

interface CommandOutputBlockProps {
  command?: string | null;
  output: string;
  status?: string | null;
  className?: string;
  compact?: boolean;
  collapsible?: boolean;
  defaultOutputVisible?: boolean;
  subtle?: boolean;
  /**
   * Render only the output body: no command header, no copy/eye/stop
   * controls, no outer ring or fill. The host supplies the chrome (the
   * command panel in AgentJobThreadPreviewLayout already names the command in
   * its header and carries the copy control in its trailing cluster).
   */
  bodyOnly?: boolean;
  onCancel?: (() => void | Promise<void>) | null;
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeCommandOutputText(output: string | null | undefined): string {
  return normalizeLineBreaks(typeof output === "string" ? output : "").trimEnd();
}

/**
 * Copies a command's output to the clipboard and reports through the status
 * bar. Shared by the block's own copy control and hosts that draw their own.
 */
export function useCopyCommandOutput(output: string): () => Promise<void> {
  const { showStatus } = useStatus();
  return useCallback(async () => {
    try {
      await writeClipboardText(normalizeCommandOutputText(output));
      showStatus("Copied output.", "success", 2000, { presentation: "confirmation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy output.";
      showStatus(message, "error", 3500);
    }
  }, [output, showStatus]);
}

function buildCollapsedWindow(value: string): OutputWindow {
  if (value.length <= COLLAPSED_TAIL_CHARS) {
    return { text: value, omittedChars: 0, mode: "full" };
  }

  const omittedChars = value.length - COLLAPSED_TAIL_CHARS;
  return { text: value.slice(-COLLAPSED_TAIL_CHARS), omittedChars, mode: "tail" };
}

export function summarizeCommandOutputForPreview(output: string, maxLength = 200): string {
  const normalized = normalizeLineBreaks(output).trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines[lines.length - 1] ?? normalized;
  if (candidate.length <= maxLength) {
    return candidate;
  }
  return `${candidate.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function CommandOutputBlock({
  command,
  output,
  status,
  className,
  compact = false,
  collapsible = false,
  defaultOutputVisible = true,
  subtle = false,
  bodyOnly = false,
  onCancel = null,
}: CommandOutputBlockProps) {
  const normalized = useMemo(() => normalizeCommandOutputText(output), [output]);
  const commandText = typeof command === "string" ? command.trim() : "";
  const statusNormalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  const isRunning = RUNNING_STATUSES.has(statusNormalized);
  const { showStatus } = useStatus();
  const handleCopy = useCopyCommandOutput(normalized);

  const [viewerOpen, setViewerOpen] = useState(false);
  const [outputVisible, setOutputVisible] = useState(collapsible ? defaultOutputVisible : true);
  const [cancelPending, setCancelPending] = useState(false);
  const [showAllLines, setShowAllLines] = useState(false);
  const closeViewer = () => setViewerOpen(false);

  useEffect(() => {
    setOutputVisible(collapsible ? defaultOutputVisible : true);
  }, [collapsible, defaultOutputVisible, commandText, normalized]);

  useEffect(() => {
    setShowAllLines(false);
  }, [commandText]);

  useEffect(() => {
    if (!viewerOpen) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeViewer();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [viewerOpen]);

  const canCancel = isRunning && typeof onCancel === "function";

  const handleCancel = async () => {
    if (!onCancel || cancelPending) {
      return;
    }
    setCancelPending(true);
    try {
      await onCancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to stop the command.";
      showStatus(message, "error", 3500);
    } finally {
      setCancelPending(false);
    }
  };

  const collapsedWindow = useMemo(() => buildCollapsedWindow(normalized), [normalized]);
  const lines = useMemo(() => (normalized ? normalized.split("\n") : []), [normalized]);

  if (!normalized) {
    return null;
  }

  if (bodyOnly) {
    // Headerless body for hosts that already name the command: the tail of
    // the output in the code-block text tones, long lines scroll sideways,
    // and past the line cap an inline text control reveals the rest.
    const lineCapped = !showAllLines && lines.length > COMMAND_OUTPUT_BODY_LINE_CAP;
    const visibleText = lineCapped ? lines.slice(-COMMAND_OUTPUT_BODY_LINE_CAP).join("\n") : normalized;
    return (
      <div
        className={`min-w-0 ${className ?? ""}`}
        data-testid="chat-command-output"
        data-body-only="true"
        data-streaming={isRunning ? "true" : undefined}
      >
        <pre
          className={`${showAllLines ? "max-h-96 overflow-y-auto" : ""} overflow-x-auto whitespace-pre font-mono text-xxs leading-snug text-slate-700 dark:text-slate-200`}
        >
          {visibleText}
        </pre>
        {lineCapped ? (
          <button
            type="button"
            onClick={() => setShowAllLines(true)}
            className="mt-1 text-xxs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
          >
            Show all {lines.length.toLocaleString()} lines
          </button>
        ) : null}
      </div>
    );
  }

  const maxHeightClass = compact ? (isRunning ? "max-h-52" : "max-h-28") : isRunning ? "max-h-72" : "max-h-44";
  const preview = summarizeCommandOutputForPreview(normalized, compact ? 120 : 200);
  const collapsedPreview =
    preview && !/^[}\]]$/.test(preview)
      ? preview
      : "Output hidden - expand to inspect.";

  const metaLabel = isRunning
    ? "Streaming…"
    : collapsedWindow.omittedChars > 0
      ? `… ${collapsedWindow.omittedChars.toLocaleString()} chars omitted`
      : statusNormalized && statusNormalized !== "completed"
        ? statusNormalized.replace(/[_-]+/g, " ")
        : null;

  return (
    <div
      className={`overflow-hidden rounded-xl border text-slate-900 dark:text-slate-100 ${
        subtle
          ? "border-slate-200/70 bg-white/55 shadow-none dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]"
          : "border-slate-200/70 bg-slate-50 shadow-sm dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-strong)] dark:shadow-inner"
      } ${className ?? ""}`}
      data-testid="chat-command-output"
    >
      <div
        className={`flex items-center justify-between gap-2 px-2.5 py-1.5 ${
          outputVisible || (!outputVisible && collapsedPreview)
            ? "border-b border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]"
            : ""
        }`}
      >
        {commandText ? (
          <div className="min-w-0 flex items-center gap-2">
            <Terminal className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-300" aria-hidden="true" />
            <Text
              as="span"
              variant="mono"
              tone="inherit"
              title={commandText}
              className="min-w-0 truncate text-xxs text-slate-900 dark:text-slate-100"
            >
              {commandText}
            </Text>
            {metaLabel ? (
              <Text
                as="span"
                variant="caption"
                tone="inherit"
                className={`flex-shrink-0 text-xxs ${
                  isRunning
                    ? "instafy-status-sweep"
                    : "text-slate-500 dark:text-slate-400"
                }`}
                data-sweep-text={isRunning ? metaLabel : undefined}
              >
                {metaLabel}
              </Text>
            ) : null}
          </div>
        ) : (
          <div className="min-w-0">
            {metaLabel ? (
              <Text
                as="span"
                variant="caption"
                tone="inherit"
                className={`text-xxs ${
                  isRunning
                    ? "instafy-status-sweep"
                    : "text-slate-500 dark:text-slate-400"
                }`}
                data-sweep-text={isRunning ? metaLabel : undefined}
              >
                {metaLabel}
              </Text>
            ) : null}
          </div>
        )}
        <div className="flex items-center gap-1">
          {collapsible ? (
            <IconButton
              aria-label={outputVisible ? "Hide command output" : "Show command output"}
              variant="ghost"
              size="xs"
              radius="full"
              onPress={() => setOutputVisible((value) => !value)}
              className="text-slate-500 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
            >
              <NavArrowRight
                className={`h-3.5 w-3.5 transition-transform ${outputVisible ? "rotate-90" : ""}`}
                aria-hidden="true"
              />
            </IconButton>
          ) : null}
          {canCancel ? (
            <IconButton
              aria-label="Stop command"
              variant="ghost"
              size="xs"
              radius="full"
              onPress={() => void handleCancel()}
              isDisabled={cancelPending}
              data-testid="chat-command-stop-button"
              className="text-rose-500 hover:text-rose-600 dark:text-rose-300 dark:hover:text-rose-200"
            >
              <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton
            aria-label="Copy full output"
            variant="ghost"
            size="xs"
            radius="full"
            onPress={() => void handleCopy()}
            className="text-slate-500 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label="View full output"
            variant="ghost"
            size="xs"
            radius="full"
            onPress={() => setViewerOpen(true)}
            className="text-slate-500 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      {outputVisible ? (
        <pre
          className={`${maxHeightClass} overflow-auto px-3 py-2 font-mono text-xxs leading-snug text-slate-900 dark:text-slate-100`}
        >
          {collapsedWindow.text}
        </pre>
      ) : collapsedPreview ? (
        <div className="truncate px-3 py-1.5 font-mono text-xxs leading-snug text-slate-500 dark:text-slate-400">
          {collapsedPreview}
        </div>
      ) : null}

      {viewerOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-900/60 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Full command output"
          onClick={closeViewer}
          style={{
            paddingBottom: "max(var(--instafy-safe-area-inset-bottom), 1rem)",
            paddingLeft: "max(var(--instafy-safe-area-inset-left), 1rem)",
            paddingRight: "max(var(--instafy-safe-area-inset-right), 1rem)",
            paddingTop: "max(var(--instafy-safe-area-inset-top), 1rem)",
          }}
        >
          <div
            className="w-full max-w-[min(960px,94vw)] overflow-hidden rounded-3xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-[color:var(--color-studio-dark-divider)]">
              {commandText ? (
                <Text
                  as="div"
                  variant="mono"
                  tone="inherit"
                  className="min-w-0 truncate text-sm text-slate-900 dark:text-slate-100"
                >
                  {commandText}
                </Text>
              ) : (
                <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm">
                  Output
                </Text>
              )}
              <div className="flex items-center gap-1">
                <IconButton
                  aria-label="Copy full output"
                  variant="ghost"
                  size="sm"
                  radius="full"
                  onPress={() => void handleCopy()}
                  className="text-slate-500 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white"
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  aria-label="Close output"
                  variant="ghost"
                  size="sm"
                  radius="full"
                  onPress={closeViewer}
                  className="text-slate-500 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white"
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
            </div>
            <pre className="max-h-[72vh] overflow-auto px-4 py-3 font-mono text-xs leading-snug text-slate-900 dark:text-slate-100">
              {normalized}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
