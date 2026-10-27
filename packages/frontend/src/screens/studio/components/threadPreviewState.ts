export type ThreadCompactUpdateKind =
  | "compaction"
  | "thinking"
  | "plan"
  | "tool"
  | "command"
  | "search"
  | "runtime";

export type ThreadPreviewRunPhase = "running" | "completed" | "unknown";

export function isThreadPreviewUnresolved(params: {
  isCompleted: boolean;
  isRunning: boolean;
  isThreadRunInFlight: boolean;
  hasRecentThreadActivity: boolean;
  runPhase: ThreadPreviewRunPhase;
}): boolean {
  if (params.isCompleted) {
    return false;
  }
  return (
    params.isRunning ||
    params.isThreadRunInFlight ||
    params.hasRecentThreadActivity
  );
}
