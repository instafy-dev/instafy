export type ThreadCompactUpdateKind =
  | "compaction"
  | "thinking"
  | "plan"
  | "tool"
  | "command"
  | "search"
  | "runtime";

export type ThreadPreviewRunPhase = "running" | "completed" | "unknown";

export function resolveThreadCompactUpdateLabel(kind: ThreadCompactUpdateKind): string {
  switch (kind) {
    case "compaction":
      return "Re-organizing my thoughts";
    case "thinking":
      return "Thinking";
    case "plan":
      return "Plan update";
    case "tool":
      return "Tool call";
    case "command":
      return "Command";
    case "search":
      return "Web search";
    case "runtime":
      return "Runtime update";
    default:
      return "Update";
  }
}

export function resolveThreadCompactUpdateHistoryLabel(kind: ThreadCompactUpdateKind): string {
  switch (kind) {
    case "compaction":
      return "Context compaction";
    case "thinking":
      return "Reasoning";
    case "plan":
      return "Plan update";
    case "tool":
      return "Tool call";
    case "command":
      return "Command";
    case "search":
      return "Web search";
    case "runtime":
      return "Runtime update";
    default:
      return "Update";
  }
}

export function resolveThreadCompactUpdateLiveLabel(kind: ThreadCompactUpdateKind): string {
  switch (kind) {
    case "compaction":
      return "Re-organizing my thoughts…";
    case "thinking":
      return "Thinking…";
    case "plan":
      return "Updating plan…";
    case "tool":
      return "Calling tool…";
    case "command":
      return "Running command…";
    case "search":
      return "Searching the web…";
    case "runtime":
      return "Switching runtime…";
    default:
      return "Thinking…";
  }
}

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

export function resolveCompactRailStatusText(params: {
  showCompactRailCommandStatus: boolean;
  commandPreview: string;
  latestCompactEventKind: ThreadCompactUpdateKind | null;
  runningStatusLabel: string | null;
}): string {
  if (params.showCompactRailCommandStatus) {
    const preview = params.commandPreview.trim();
    if (preview) {
      return preview;
    }
    return "Running command…";
  }
  if (params.latestCompactEventKind) {
    return resolveThreadCompactUpdateLiveLabel(params.latestCompactEventKind);
  }
  const runningStatusLabel = params.runningStatusLabel?.trim() ?? "";
  if (runningStatusLabel) {
    return runningStatusLabel;
  }
  return "Thinking…";
}

export function shouldRenderCompactRailStatus(params: {
  isHybridCompactionActive: boolean;
  isCompleted: boolean;
  showLiveCommandOutput: boolean;
  isUnresolved: boolean;
  showCompactIconRail: boolean;
  showCompactRailWaitingSpinner: boolean;
}): boolean {
  return (
    params.isHybridCompactionActive &&
    !params.isCompleted &&
    !params.showLiveCommandOutput &&
    (params.isUnresolved || params.showCompactIconRail || params.showCompactRailWaitingSpinner)
  );
}

export function shouldSweepCompactRailStatusText(params: {
  showCompactRailStatus: boolean;
  isUnresolved: boolean;
}): boolean {
  return params.showCompactRailStatus && params.isUnresolved;
}

export function shouldSuppressSummaryRunningStatus(params: {
  showCompactRailStatus: boolean;
  showRunningSpinnerFallback: boolean;
  useCompactRunningPreview: boolean;
  hasRunningStatusLabel: boolean;
}): boolean {
  if (!params.showCompactRailStatus) {
    return false;
  }
  if (params.showRunningSpinnerFallback) {
    return true;
  }
  return params.useCompactRunningPreview && params.hasRunningStatusLabel;
}
