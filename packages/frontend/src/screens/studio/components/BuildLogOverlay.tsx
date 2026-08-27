import { useEffect, useMemo, useRef } from "react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { useStatus } from "../../../status/useStatus";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import type { BuildLogEntry } from "../../../types";

interface BuildLogOverlayProps {
  logs: BuildLogEntry[];
  onClear: () => void;
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
  emptySummary?: string;
  emptyBody?: string;
  copyText?: string;
}

function severityStyles(severity: BuildLogEntry["severity"]): { badge: string; dot: string; label: string } {
  switch (severity) {
    case "error":
      return {
        badge: "bg-rose-500/20 text-rose-200 border border-rose-400/40",
        dot: "bg-rose-400",
        label: "Error"
      };
    case "warn":
      return {
        badge: "bg-secondary-500/20 text-secondary-200 border border-secondary-400/40",
        dot: "bg-secondary-300",
        label: "Warning"
      };
    default:
      return {
        badge: "bg-slate-500/20 text-slate-200 border border-slate-400/30",
        dot: "bg-slate-300",
        label: "Info"
      };
  }
}

function formatTimestamp(value: number | string): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function BuildLogOverlay({
  logs,
  onClear,
  onClose,
  title = "Runtime logs",
  ariaLabel = "Runtime logs",
  emptySummary = "No build output yet. Trigger a generation to see live logs.",
  emptyBody = "Logs will appear here when a runtime task emits output.",
  copyText,
}: BuildLogOverlayProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const { showStatus } = useStatus();

  const summary = useMemo(() => {
    return logs.reduce(
      (acc, entry) => {
        acc.total += 1;
        acc[entry.severity] += 1;
        return acc;
      },
      { total: 0, info: 0, warn: 0, error: 0 } as Record<"total" | "info" | "warn" | "error", number>
    );
  }, [logs]);

  const summaryLabel =
    summary.total > 0 ? `${summary.total} entries · ${summary.error} errors · ${summary.warn} warnings` : emptySummary;

  const handleCopy = async () => {
    if (!copyText) {
      return;
    }
    try {
      await writeClipboardText(copyText);
      showStatus("Copied to clipboard.", "success", 2500, { presentation: "confirmation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy.";
      showStatus(message, "error", 3500);
    }
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logs]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/70 backdrop-blur pb-[max(var(--instafy-safe-area-inset-bottom),1rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),1rem)]"
      data-testid="build-log-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="relative flex h-[min(90vh,820px)] max-h-full w-[min(960px,92vw)] flex-col gap-4 rounded-3xl border border-white/10 bg-slate-950/90 p-5 text-slate-100 shadow-modal"
        data-testid="build-log-panel"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <Heading level={2} tone="inverse" variant="title">
              {title}
            </Heading>
            {summaryLabel ? (
              <Text variant="caption" tone="subtle" className="mt-1 text-slate-300">
                {summaryLabel}
              </Text>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {copyText ? (
              <Button
                onPress={handleCopy}
                variant="outline"
                size="xs"
                radius="full"
                className="border-white/20 text-slate-200 hover:bg-white/10 data-[hovered]:bg-white/10"
              >
                Copy
              </Button>
            ) : null}
            <Button
              onPress={onClear}
              isDisabled={summary.total === 0}
              variant="outline"
              size="xs"
              radius="full"
              className="border-white/20 text-slate-200 hover:bg-white/10 data-[hovered]:bg-white/10"
            >
              Clear
            </Button>
            <Button
              ref={closeButtonRef}
              onPress={onClose}
              variant="primary"
              size="xs"
              radius="full"
              className="!bg-white !text-slate-900 shadow-sm hover:brightness-105 data-[hovered]:brightness-105"
            >
              Close
            </Button>
          </div>
        </header>
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto rounded-3xl border border-white/10 bg-slate-950/70 px-4 py-4"
        >
          {summary.total === 0 ? (
            <Text as="div" variant="body" tone="subtle" className="flex h-full items-center justify-center">
              {emptyBody}
            </Text>
          ) : (
            <ul className="space-y-3">
              {logs.map((entry) => {
                const styles = severityStyles(entry.severity);
                return (
                  <li key={entry.id} className="rounded-2xl border border-white/5 bg-slate-950/50 p-3 shadow-inner">
                    <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-wide text-slate-300">
                      <Badge size="xs" className={`gap-2 ${styles.badge}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} aria-hidden="true" />
                        {styles.label}
                      </Badge>
                      <Text as="span" variant="mono" tone="subtle" className="text-xxs">
                        {formatTimestamp(entry.timestamp)}
                      </Text>
                    </div>
                    <Text
                      as="p"
                      variant="body"
                      tone="inherit"
                      className="mt-3 whitespace-pre-line font-mono text-slate-100"
                    >
                      {entry.message}
                    </Text>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
