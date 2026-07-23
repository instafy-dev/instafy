import { useMemo, useState } from "react";
import type { BuildLogEntry } from "../../../types";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Text } from "../../../components/Text";

interface BuildLogConsoleProps {
  logs: BuildLogEntry[];
  onClear: () => void;
}

function severityClass(severity: BuildLogEntry["severity"]): string {
  switch (severity) {
    case "error":
      return "text-rose-600";
    case "warn":
      return "text-secondary-600";
    default:
      return "text-slate-600";
  }
}

function severityLabel(severity: BuildLogEntry["severity"]): string {
  switch (severity) {
    case "error":
      return "Errors";
    case "warn":
      return "Warnings";
    default:
      return "Info";
  }
}

export function BuildLogConsole({ logs, onClear }: BuildLogConsoleProps) {
  const [isOpen, setIsOpen] = useState(false);
  const counts = useMemo(() => {
    return logs.reduce(
      (acc, log) => {
        acc.total += 1;
        acc[log.severity] += 1;
        return acc;
      },
      { total: 0, info: 0, warn: 0, error: 0 } as Record<"total" | "info" | "warn" | "error", number>
    );
  }, [logs]);

  if (logs.length === 0) {
    return null;
  }

  return (
    <Card tone="subtle" radius="3xl" shadow="sm" padding="md">
      <div className="flex items-center justify-between">
        <Button
          onPress={() => setIsOpen((open) => !open)}
          variant="ghost"
          size="sm"
          radius="lg"
          className="justify-start text-left"
        >
          <Text as="span" variant="bodyStrong" tone="primary">
            Build console
          </Text>
          <Text as="span" variant="caption" tone="muted" className="ml-2">
            {counts.error > 0 ? `${counts.error} errors · ` : ""}
            {counts.warn > 0 ? `${counts.warn} warnings · ` : ""}
            {counts.total} lines
          </Text>
        </Button>
        <Button
          onPress={onClear}
          variant="outline"
          size="xs"
          radius="full"
        >
          Clear
        </Button>
      </div>
      {isOpen ? (
        <div className="mt-3 max-h-60 overflow-y-auto rounded-2xl border border-slate-900/60 bg-slate-950/90 p-3 text-xs text-slate-100">
          <ul className="space-y-2">
            {logs.map((entry) => (
              <li key={entry.id} className="font-mono">
                <span className={`mr-2 text-xs font-medium ${severityClass(entry.severity)}`}>
                  {severityLabel(entry.severity)}
                </span>
                <span className="text-slate-400">[{new Date(entry.timestamp).toLocaleTimeString()}]</span>
                <span className="ml-2 text-slate-100">{entry.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
