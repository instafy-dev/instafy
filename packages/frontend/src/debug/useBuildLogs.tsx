
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRuntime } from "../runtime/useRuntime";

const MAX_BUILD_LOG_LINES = 200;

interface BuildLogEntry {
  id: string;
  severity: "info" | "warn" | "error";
  message: string;
  timestamp: number;
}

const EMPTY_BUILD_LOGS: BuildLogEntry[] = [];

export function useBuildLogs(options?: { manageOverlay?: boolean }) {
  const { runtime, updateRuntime } = useRuntime();
  const buildLogs = runtime.buildLogs ?? EMPTY_BUILD_LOGS;
  const hasBuildLogs = buildLogs.length > 0;
  const manageOverlay = options?.manageOverlay ?? true;

  const [isBuildLogOverlayOpen, setIsBuildLogOverlayOpen] = useState(false);

  const recentBuildLogs = useMemo(() => buildLogs.slice(-5), [buildLogs]);

  const appendBuildLog = useCallback(
    (severity: BuildLogEntry["severity"], message: string) => {
      const entry: BuildLogEntry = {
        id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        severity,
        message,
        timestamp: Date.now()
      };
      updateRuntime((current) => {
        const nextLogs = [...(current.buildLogs ?? []), entry];
        const trimmed =
          nextLogs.length > MAX_BUILD_LOG_LINES
            ? nextLogs.slice(nextLogs.length - MAX_BUILD_LOG_LINES)
            : nextLogs;
        return {
          ...current,
          buildLogs: trimmed
        };
      });
    },
    [updateRuntime]
  );

  const handleClearBuildLogs = useCallback(() => {
    updateRuntime((current) => ({
      ...current,
      buildLogs: []
    }));
  }, [updateRuntime]);

  const handleShowBuildLogs = useCallback(() => {
    if (!manageOverlay || !hasBuildLogs) {
      return;
    }
    setIsBuildLogOverlayOpen(true);
  }, [hasBuildLogs, manageOverlay]);

  const handleHideBuildLogs = useCallback(() => {
    if (!manageOverlay) {
      return;
    }
    setIsBuildLogOverlayOpen(false);
  }, [manageOverlay]);

  useEffect(() => {
    if (!manageOverlay) {
      return;
    }
    if (!hasBuildLogs) {
      setIsBuildLogOverlayOpen(false);
    }
  }, [hasBuildLogs, manageOverlay]);

  return {
    buildLogs,
    recentBuildLogs,
    hasBuildLogs,
    isBuildLogOverlayOpen: manageOverlay ? isBuildLogOverlayOpen : false,
    appendBuildLog,
    handleClearBuildLogs,
    handleShowBuildLogs: manageOverlay ? handleShowBuildLogs : () => {},
    handleHideBuildLogs: manageOverlay ? handleHideBuildLogs : () => {}
  };
}
