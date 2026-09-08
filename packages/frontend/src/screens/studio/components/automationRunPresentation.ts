import type { ControllerAutomation } from "../../../sdk/instafy";
import type { RunRecord, RunStatus } from "../../../types";

const RUN_LABELS: Record<RunStatus, string> = {
  queued: "Turn queued",
  in_progress: "Turn running",
  awaiting_approval: "Awaiting approval",
  success: "Turn completed",
  failed: "Turn failed",
  canceled: "Turn canceled",
  merged: "Turn merged",
};

export function getAutomationScheduleLabel(automation: ControllerAutomation): string {
  if (automation.scheduleKind === "once" && automation.status === "paused" && !automation.nextRunAt && automation.lastRunAt) {
    // The scheduler records an attempt, not the outcome of the dispatched turn.
    return "One-time schedule finished";
  }
  return automation.status === "paused" ? "Schedule paused" : "Schedule active";
}

export function getAutomationLatestRun(automation: ControllerAutomation, runs: Iterable<RunRecord>): RunRecord | null {
  const attemptedAt = automation.lastRunAt ? Date.parse(automation.lastRunAt) : null;
  let latest: RunRecord | null = null;
  let latestCreatedAt = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (run.projectId !== automation.projectId || run.runType !== "prompt") continue;
    if (!automation.conversationId || run.conversationId !== automation.conversationId) continue;
    const attribution = run.metadata?.automation;
    if (!attribution || typeof attribution !== "object" || Array.isArray(attribution) ||
        (attribution as Record<string, unknown>).id !== automation.id) continue;
    const createdAt = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
    if (!Number.isFinite(createdAt) || (attemptedAt !== null && (!Number.isFinite(attemptedAt) || createdAt < attemptedAt))) continue;
    // Completion time cannot make an older attempt become the newest turn.
    if (createdAt > latestCreatedAt) {
      latest = run;
      latestCreatedAt = createdAt;
    }
  }
  return latest;
}

export function getAutomationRunPresentation(run: RunRecord) {
  const message = run.lastMessage?.trim() ?? "";
  const characters = Array.from(message);
  return {
    label: RUN_LABELS[run.status],
    tone: run.status === "failed" ? "danger" as const : "muted" as const,
    // A run can complete without a summary and retain its previous progress
    // message. This field does not prove a final answer or a task outcome.
    summaryLabel: "Latest update",
    summary: characters.length > 400 ? `${characters.slice(0, 400).join("")}…` : message,
  };
}
