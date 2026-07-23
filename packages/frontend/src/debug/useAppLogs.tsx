import { useSyncExternalStore } from "react";
import { clearAppLogs, getAppLogs, subscribeAppLogs } from "./appLogs";

export function useAppLogs() {
  const logs = useSyncExternalStore(subscribeAppLogs, getAppLogs, getAppLogs);
  const hasLogs = logs.length > 0;
  const hasErrors = logs.some((entry) => entry.severity === "error");

  return {
    logs,
    hasLogs,
    hasErrors,
    clearLogs: clearAppLogs,
  };
}

