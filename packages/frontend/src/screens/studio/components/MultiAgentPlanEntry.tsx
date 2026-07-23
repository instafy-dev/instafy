import { Fragment, useMemo, useState } from "react";
import { CheckCircle, GitBranch, MoreHoriz, WarningTriangle } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { cancelPlanGroup } from "../../../services/runtimeController/jobs";
import type { ChatMessage } from "../types";
import { extractAgentJobId } from "./chatMessagePresentation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MultiAgentPlanAgent = {
  handle: string;
  label: string;
  scopeSummary: string;
  writeMode: string;
};

type WorkerEvidenceVisibility = "hidden" | "compact" | "expanded" | "surface_on_failure";
type LeadSummaryVisibility = "hidden" | "compact";

type MultiAgentPlanPresentation = {
  workerEvidenceVisibility: WorkerEvidenceVisibility;
  leadSummaryVisibility: LeadSummaryVisibility;
  showThresholdReason: boolean;
};

type MultiAgentPlanView = {
  mode: string;
  rationale: string;
  thresholdReason: string;
  agents: MultiAgentPlanAgent[];
  leadHandle: string;
  continuationPrompt: string;
  expectedReportFormat: string;
  presentation: MultiAgentPlanPresentation;
};

type TeamActivityStatus = "queued" | "working" | "done" | "failed";

type TeamActivity = {
  key: string;
  status: TeamActivityStatus;
  jobId: string;
  summary: string;
  evidence: string;
  leaseMetrics: TeamLeaseMetrics | null;
  toolUpdateCount: number;
};

type TeamLeaseMetrics = {
  queuedAt: string | null;
  leasedAt: string | null;
  completedAt: string | null;
  queueWaitMs: number | null;
  wallTimeMs: number | null;
  leaseAttempts: number | null;
  leasedByRuntimeId: string | null;
  agentHandle: string | null;
  toolUpdateCount: number | null;
};

type TeamRuntimeSummary = {
  label: string;
  title: string;
};

const TOOL_UPDATE_MESSAGE_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "web_search",
  "file_change",
]);

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizePlanHandle(value: unknown): string {
  const normalized = stringField(value).replace(/^@+/, "").trim().toLowerCase();
  return normalized ? `@${normalized}` : "";
}

function normalizeHandleKey(value: unknown): string {
  return stringField(value).replace(/^@+/, "").trim().toLowerCase();
}

function normalizePlanMode(value: unknown, fallback: string): string {
  const normalized = stringField(value).replace(/-/g, "_").toLowerCase();
  return normalized || fallback;
}

function normalizeWorkerEvidenceVisibility(value: unknown): WorkerEvidenceVisibility {
  const normalized = stringField(value).replace(/-/g, "_").toLowerCase();
  switch (normalized) {
    case "hidden":
      return "hidden";
    case "expanded":
      return "expanded";
    case "compact":
      return "compact";
    case "surface_on_failure":
    case "failure_only":
    case "on_failure":
      return "surface_on_failure";
    default:
      return "surface_on_failure";
  }
}

function normalizeLeadSummaryVisibility(value: unknown): LeadSummaryVisibility {
  const normalized = stringField(value).replace(/-/g, "_").toLowerCase();
  return normalized === "hidden" ? "hidden" : "compact";
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseMultiAgentPlan(details: Record<string, unknown> | null): MultiAgentPlanView | null {
  details = normalizeMultiAgentPlanDetails(details);
  if (!details) {
    return null;
  }
  const rawAgents = Array.isArray(details.agents) ? details.agents : [];
  const agents = rawAgents
    .filter(isRecord)
    .map((agent): MultiAgentPlanAgent | null => {
      const handle = normalizePlanHandle(agent.handle);
      const label = stringField(agent.label) || handle || "Agent";
      const scopeSummary =
        stringField(agent.scopeSummary) || stringField(agent.scope_summary) || stringField(agent.scope);
      const writeScope = isRecord(agent.writeScope)
        ? agent.writeScope
        : isRecord(agent.write_scope)
          ? agent.write_scope
          : null;
      const writeMode = normalizePlanMode(writeScope?.mode, normalizePlanMode(details.mode, "read_only"));
      if (!handle && !scopeSummary) {
        return null;
      }
      return {
        handle,
        label,
        scopeSummary,
        writeMode,
      };
    })
    .filter((agent): agent is MultiAgentPlanAgent => agent !== null);

  const lead = isRecord(details.lead)
    ? details.lead
    : isRecord(details.leadContinuation)
      ? details.leadContinuation
      : isRecord(details.synthesis)
        ? details.synthesis
        : null;
  const presentation = isRecord(details.presentation)
    ? details.presentation
    : isRecord(details.attention)
      ? details.attention
      : null;
  return {
    mode: normalizePlanMode(details.mode, "read_only"),
    rationale: stringField(details.rationale),
    thresholdReason: stringField(details.thresholdReason) || stringField(details.threshold_reason),
    agents,
    leadHandle: normalizePlanHandle(lead?.leadHandle ?? lead?.lead_handle),
    continuationPrompt:
      stringField(lead?.continuationPrompt ?? lead?.continuation_prompt) || stringField(lead?.prompt),
    expectedReportFormat: stringField(lead?.expectedReportFormat ?? lead?.expected_report_format),
    presentation: {
      workerEvidenceVisibility: normalizeWorkerEvidenceVisibility(
        presentation?.workerEvidenceVisibility ??
          presentation?.worker_evidence_visibility ??
          presentation?.workerEvidence ??
          presentation?.worker_evidence,
      ),
      leadSummaryVisibility: normalizeLeadSummaryVisibility(
        presentation?.leadSummaryVisibility ??
          presentation?.lead_summary_visibility ??
          presentation?.leadSummary ??
          presentation?.lead_summary,
      ),
      showThresholdReason: booleanField(
        presentation?.showThresholdReason ?? presentation?.show_threshold_reason,
        false,
      ),
    },
  };
}

function extractMetadata(message?: ChatMessage | null): Record<string, unknown> | null {
  if (!message) {
    return null;
  }
  return message.metadata && isRecord(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
}

function looksLikeMultiAgentPlan(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.agents) ||
    isRecord(value.lead) ||
    isRecord(value.synthesis) ||
    stringField(value.type).toLowerCase() === "multi_agent_plan"
  );
}

function looksLikePlanWrapper(value: Record<string, unknown>): boolean {
  return (
    stringField(value.kind).toLowerCase() === "runtime_selection" ||
    stringField(value.messageType).toLowerCase() === "multi_agent_plan" ||
    stringField(value.message_type).toLowerCase() === "multi_agent_plan" ||
    Boolean(stringField(value.runtimeId) || stringField(value.displayName))
  );
}

function normalizeMultiAgentPlanDetails(details: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!details) {
    return null;
  }
  let current: Record<string, unknown> = details;
  const seen = new Set<Record<string, unknown>>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    if (looksLikeMultiAgentPlan(current) && Array.isArray(current.agents)) {
      return current;
    }
    const direct = isRecord(current.multiAgentPlan)
      ? current.multiAgentPlan
      : isRecord(current.multi_agent_plan)
        ? current.multi_agent_plan
        : null;
    if (direct) {
      current = direct;
      continue;
    }
    const nested = isRecord(current.details) ? current.details : null;
    if (nested && (looksLikePlanWrapper(current) || looksLikeMultiAgentPlan(nested))) {
      current = nested;
      continue;
    }
    break;
  }
  return looksLikeMultiAgentPlan(current) ? current : null;
}

function extractNestedRecord(metadata: Record<string, unknown> | null, key: string, fallbackKey: string): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  const direct = metadata[key];
  if (isRecord(direct)) {
    return direct;
  }
  const fallback = metadata[fallbackKey];
  return isRecord(fallback) ? fallback : null;
}

function extractAgentHandle(message: ChatMessage): string {
  const metadata = extractMetadata(message);
  const agent = extractNestedRecord(metadata, "agent", "agent");
  return normalizeHandleKey(agent?.handle);
}

function extractMultiAgentPlanMeta(message: ChatMessage): Record<string, unknown> | null {
  const metadata = extractMetadata(message);
  return extractNestedRecord(metadata, "multiAgentPlan", "multi_agent_plan");
}

function extractLeaseMetrics(message: ChatMessage): TeamLeaseMetrics | null {
  const metadata = extractMetadata(message);
  const raw = isRecord(metadata?.leaseMetrics)
    ? metadata.leaseMetrics
    : isRecord(metadata?.lease_metrics)
      ? metadata.lease_metrics
      : null;
  if (!raw) {
    return null;
  }
  return {
    queuedAt: stringField(raw.queuedAt ?? raw.queued_at) || null,
    leasedAt: stringField(raw.leasedAt ?? raw.leased_at) || null,
    completedAt: stringField(raw.completedAt ?? raw.completed_at) || null,
    queueWaitMs: numberField(raw.queueWaitMs ?? raw.queue_wait_ms),
    wallTimeMs: numberField(raw.wallTimeMs ?? raw.wall_time_ms),
    leaseAttempts: numberField(raw.leaseAttempts ?? raw.lease_attempts),
    leasedByRuntimeId: stringField(raw.leasedByRuntimeId ?? raw.leased_by_runtime_id) || null,
    agentHandle: stringField(raw.agentHandle ?? raw.agent_handle) || null,
    toolUpdateCount: numberField(raw.toolUpdateCount ?? raw.tool_update_count),
  };
}

function extractMessageType(message: ChatMessage): string {
  const direct = typeof message.messageType === "string" ? message.messageType.trim().toLowerCase() : "";
  if (direct) {
    return direct;
  }
  const metadata = extractMetadata(message);
  return typeof metadata?.messageType === "string" ? metadata.messageType.trim().toLowerCase() : "";
}

function extractMessageOutcome(message: ChatMessage): string {
  const metadata = extractMetadata(message);
  return typeof metadata?.outcome === "string" ? metadata.outcome.trim().toLowerCase() : "";
}

function isFailedMessage(message: ChatMessage): boolean {
  const messageType = extractMessageType(message);
  const outcome = extractMessageOutcome(message);
  return (
    messageType === "error" ||
    outcome === "failed" ||
    outcome === "failure" ||
    outcome === "error" ||
    outcome === "canceled" ||
    outcome === "cancelled"
  );
}

function isWorkingMessage(message: ChatMessage): boolean {
  const metadata = extractMetadata(message);
  const kind = typeof metadata?.kind === "string" ? metadata.kind.trim().toLowerCase() : "";
  const outcome = extractMessageOutcome(message);
  return kind === "update" && (!outcome || outcome === "in_progress" || outcome === "running");
}

function isToolUpdateMessage(message: ChatMessage): boolean {
  return TOOL_UPDATE_MESSAGE_TYPES.has(extractMessageType(message));
}

function isDoneMessage(message: ChatMessage): boolean {
  const outcome = extractMessageOutcome(message);
  return outcome === "succeeded" || outcome === "success" || outcome === "completed" || outcome === "done";
}

function summarizeEvidence(content: string, maxLength = 220): string {
  const summary = content.replace(/\s+/g, " ").trim();
  if (summary.length <= maxLength) {
    return summary;
  }
  return `${summary.slice(0, maxLength - 1).trim()}…`;
}

function formatEvidence(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 1600) {
    return trimmed;
  }
  return `${trimmed.slice(0, 1599).trim()}…`;
}

function summarizeEvidenceDetail(content: string): string {
  return summarizeEvidence(content, 560);
}

function formatDuration(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  const seconds = value / 1000;
  if (seconds < 10) {
    return `${Math.round(seconds * 10) / 10}s`;
  }
  return `${Math.round(seconds)}s`;
}

function formatQueueWait(value: number | null): string | null {
  return formatDuration(value);
}

function formatWallTime(value: number | null): string | null {
  return formatDuration(value);
}

function shortenRuntimeId(runtimeId: string): string {
  const trimmed = runtimeId.trim();
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

function formatToolUpdateCount(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const count = Math.round(value);
  return `${count} tool update${count === 1 ? "" : "s"}`;
}

function formatLeaseMetrics(
  metrics: TeamLeaseMetrics | null,
  toolUpdateCount = 0,
): { label: string; title: string } | null {
  const toolUpdates = formatToolUpdateCount(toolUpdateCount);
  if (!metrics?.leasedByRuntimeId && !metrics?.queueWaitMs && !metrics?.leaseAttempts && !toolUpdates) {
    return null;
  }
  const parts: string[] = [];
  if (metrics?.leasedByRuntimeId) {
    parts.push(`runtime ${shortenRuntimeId(metrics.leasedByRuntimeId)}`);
  }
  const wait = formatQueueWait(metrics?.queueWaitMs ?? null);
  if (wait) {
    parts.push(`wait ${wait}`);
  }
  const wallTime = formatWallTime(metrics?.wallTimeMs ?? null);
  if (wallTime) {
    parts.push(`ran ${wallTime}`);
  }
  if (typeof metrics?.leaseAttempts === "number" && metrics.leaseAttempts > 1) {
    parts.push(`try ${metrics.leaseAttempts}`);
  }
  if (toolUpdates) {
    parts.push(toolUpdates);
  }
  if (parts.length === 0) {
    return null;
  }
  const titleParts = [
    metrics?.leasedByRuntimeId ? `Runtime: ${metrics.leasedByRuntimeId}` : null,
    metrics?.agentHandle ? `Agent: ${metrics.agentHandle}` : null,
    metrics?.queuedAt ? `Queued: ${metrics.queuedAt}` : null,
    metrics?.leasedAt ? `Leased: ${metrics.leasedAt}` : null,
    metrics?.completedAt ? `Completed: ${metrics.completedAt}` : null,
    wait ? `Queue wait: ${wait}` : null,
    wallTime ? `Wall time: ${wallTime}` : null,
    typeof metrics?.leaseAttempts === "number" ? `Lease attempts: ${metrics.leaseAttempts}` : null,
    toolUpdates ? `Tool updates: ${Math.round(toolUpdateCount)}` : null,
  ].filter((part): part is string => Boolean(part));
  return { label: parts.join(" · "), title: titleParts.join("\n") };
}

function formatTeamRuntimeSummary({
  plan,
  workerActivityByHandle,
}: {
  plan: MultiAgentPlanView;
  workerActivityByHandle: Map<string, TeamActivity>;
}): TeamRuntimeSummary | null {
  const rows = plan.agents
    .map((agent) => {
      const label = agent.handle || agent.label;
      const handleKey = normalizeHandleKey(label);
      const activity = workerActivityByHandle.get(handleKey) ?? null;
      const metrics = activity?.leaseMetrics ?? null;
      if (!metrics?.leasedByRuntimeId) {
        return null;
      }
      const wait = formatQueueWait(metrics.queueWaitMs);
      const wallTime = formatWallTime(metrics.wallTimeMs);
      const attempts =
        typeof metrics.leaseAttempts === "number" && metrics.leaseAttempts > 1
          ? `${metrics.leaseAttempts} attempts`
          : null;
      return {
        label,
        runtimeId: metrics.leasedByRuntimeId,
        summary: [
          label,
          `runtime ${shortenRuntimeId(metrics.leasedByRuntimeId)}`,
          wait ? `wait ${wait}` : null,
          wallTime ? `ran ${wallTime}` : null,
          attempts,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · "),
      };
    })
    .filter((row): row is { label: string; runtimeId: string; summary: string } => row !== null);

  if (rows.length === 0) {
    return null;
  }

  const uniqueRuntimeIds = new Set(rows.map((row) => row.runtimeId));
  const runtimeCount = uniqueRuntimeIds.size;
  const laneCount = rows.length;
  const label = `${runtimeCount} runtime${runtimeCount === 1 ? "" : "s"}`;
  const spreadLabel =
    runtimeCount > 1
      ? `${label} across ${laneCount} leased lane${laneCount === 1 ? "" : "s"}`
      : `${label} for ${laneCount} leased lane${laneCount === 1 ? "" : "s"}`;
  return {
    label: spreadLabel,
    title: [`Runtime spread: ${spreadLabel}`, ...rows.map((row) => `- ${row.summary}`)].join("\n"),
  };
}

function formatWorkerReferenceText({
  label,
  status,
  agent,
  activity,
  leaseMetricsLabel,
}: {
  label: string;
  status: TeamActivityStatus;
  agent: MultiAgentPlanAgent;
  activity: TeamActivity | null;
  leaseMetricsLabel: { label: string; title: string } | null;
}): string {
  return [
    label,
    `status: ${statusLabel(status)}`,
    activity?.jobId ? `job: ${activity.jobId}` : null,
    agent.scopeSummary ? `scope: ${agent.scopeSummary}` : null,
    leaseMetricsLabel?.title || null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function copyText(value: string) {
  if (!value.trim()) {
    return;
  }
  void writeClipboardText(value);
}

function collectTeamActivity({
  planMessage,
  conversationMessages,
}: {
  planMessage?: ChatMessage | null;
  conversationMessages?: ChatMessage[] | null;
}) {
  const planJobId = planMessage ? extractAgentJobId(planMessage) : null;
  const groupIds = new Set<string>();
  const workerJobIds = new Set<string>();
  const workerHandleByJobId = new Map<string, string>();
  const workerMessagesByHandle = new Map<string, ChatMessage[]>();
  const leadMessages: ChatMessage[] = [];

  for (const message of conversationMessages ?? []) {
    const planMeta = extractMultiAgentPlanMeta(message);
    if (!planMeta) {
      continue;
    }
    const role = stringField(planMeta.role).toLowerCase();
    const groupId = stringField(planMeta.groupId);
    const parentJobId = stringField(planMeta.parentJobId);
    if (role === "worker" && planJobId && parentJobId === planJobId) {
      if (groupId) {
        groupIds.add(groupId);
      }
      const jobId = extractAgentJobId(message);
      if (jobId) {
        workerJobIds.add(jobId);
        const handle = extractAgentHandle(message);
        if (handle) {
          workerHandleByJobId.set(jobId, handle);
        }
      }
    }
  }

  for (const message of conversationMessages ?? []) {
    const planMeta = extractMultiAgentPlanMeta(message);
    if (!planMeta) {
      const jobId = extractAgentJobId(message);
      const handle = jobId ? workerHandleByJobId.get(jobId) : null;
      if (handle) {
        const existing = workerMessagesByHandle.get(handle);
        if (existing) {
          existing.push(message);
        } else {
          workerMessagesByHandle.set(handle, [message]);
        }
      }
      continue;
    }
    const role = stringField(planMeta.role).toLowerCase();
    const groupId = stringField(planMeta.groupId);
    const parentJobId = stringField(planMeta.parentJobId);
    const belongsToPlan =
      Boolean(planJobId && parentJobId === planJobId) || Boolean(groupId && groupIds.has(groupId));
    if (!belongsToPlan) {
      continue;
    }
    if (role === "worker") {
      const handle = extractAgentHandle(message);
      if (!handle) {
        continue;
      }
      const existing = workerMessagesByHandle.get(handle);
      if (existing) {
        existing.push(message);
      } else {
        workerMessagesByHandle.set(handle, [message]);
      }
      const jobId = extractAgentJobId(message);
      if (jobId) {
        workerJobIds.add(jobId);
      }
      continue;
    }
    if (role === "lead_continuation") {
      leadMessages.push(message);
      continue;
    }
    const triggerJobId = stringField(planMeta.triggerJobId);
    if (triggerJobId && workerJobIds.has(triggerJobId)) {
      leadMessages.push(message);
    }
  }

  const buildActivity = (key: string, messages: ChatMessage[]): TeamActivity | null => {
    if (messages.length === 0) {
      return null;
    }
    const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
    const latest = ordered[ordered.length - 1];
    const terminalEvidence = [...ordered].reverse().find((message) => {
      if (isFailedMessage(message)) {
        return true;
      }
      if (isDoneMessage(message) && message.content.trim()) {
        return true;
      }
      return message.content.trim().length > 0 && !isWorkingMessage(message);
    });
    const evidenceSource = terminalEvidence ?? latest;
    let status: TeamActivityStatus;
    if (terminalEvidence) {
      status = isFailedMessage(terminalEvidence) ? "failed" : "done";
    } else if (isFailedMessage(latest)) {
      status = "failed";
    } else if (isWorkingMessage(latest)) {
      status = "working";
    } else if (isDoneMessage(latest) || latest.content.trim()) {
      status = "done";
    } else {
      status = "queued";
    }
    const leaseMetrics =
      [...ordered].reverse().map(extractLeaseMetrics).find((metrics) => metrics !== null) ?? null;
    const visibleToolUpdateCount = ordered.filter(isToolUpdateMessage).length;
    const metricToolUpdateCount = leaseMetrics?.toolUpdateCount ?? 0;
    const toolUpdateCount = Math.max(visibleToolUpdateCount, metricToolUpdateCount);
    return {
      key,
      status,
      jobId: extractAgentJobId(latest) ?? "",
      summary: summarizeEvidence(evidenceSource.content),
      evidence: formatEvidence(evidenceSource.content),
      leaseMetrics,
      toolUpdateCount,
    };
  };

  const workerActivityByHandle = new Map<string, TeamActivity>();
  for (const [handle, messages] of workerMessagesByHandle.entries()) {
    const activity = buildActivity(handle, messages);
    if (activity) {
      workerActivityByHandle.set(handle, activity);
    }
  }

  return {
    workerActivityByHandle,
    leadActivity: buildActivity("lead", leadMessages),
    groupId: [...groupIds][0] ?? null,
  };
}

function statusLabel(status: TeamActivityStatus): string {
  switch (status) {
    case "working":
      return "active";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "queued":
    default:
      return "queued";
  }
}

function statusChipClassName(status: TeamActivityStatus, interactive: boolean): string {
  const interactionClassName = interactive
    ? "cursor-pointer hover:bg-white hover:ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:hover:bg-slate-900/80 dark:hover:ring-slate-500"
    : "cursor-default";
  switch (status) {
    case "working":
      return `bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-400/25 ${interactionClassName}`;
    case "done":
      return `bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/25 ${interactionClassName}`;
    case "failed":
      return `bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-400/25 ${interactionClassName}`;
    case "queued":
    default:
      return `bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:ring-slate-700 ${interactionClassName}`;
  }
}

function StatusGlyph({ status }: { status: TeamActivityStatus }) {
  if (status === "done") {
    return <CheckCircle aria-hidden="true" className="h-3.5 w-3.5" />;
  }
  if (status === "failed") {
    return <WarningTriangle aria-hidden="true" className="h-3.5 w-3.5" />;
  }
  return (
    <span
      aria-hidden="true"
      className={`h-2 w-2 rounded-full ${status === "working" ? "animate-pulse bg-current" : "bg-current opacity-50"}`}
    />
  );
}

function formatTeamStatusSummary({
  plan,
  workerActivityByHandle,
  leadStatus,
}: {
  plan: MultiAgentPlanView;
  workerActivityByHandle: Map<string, TeamActivity>;
  leadStatus: TeamActivityStatus;
}): string {
  const statuses = plan.agents.map((agent) => {
    const handleKey = normalizeHandleKey(agent.handle || agent.label);
    return workerActivityByHandle.get(handleKey)?.status ?? "queued";
  });
  const failed = statuses.filter((status) => status === "failed").length;
  const done = statuses.filter((status) => status === "done").length;
  const working = statuses.filter((status) => status === "working").length;
  const queued = Math.max(0, plan.agents.length - failed - done - working);
  if (failed > 0) {
    const parts = [`${failed} need attention`];
    if (working > 0) {
      parts.push(`${working} active`);
    }
    parts.push(`${done}/${plan.agents.length} done`);
    return parts.join(" · ");
  }
  if (leadStatus === "done") {
    return `Lead ready · ${done}/${plan.agents.length} lanes`;
  }
  if (leadStatus === "working") {
    return `Lead active · ${done}/${plan.agents.length} lanes`;
  }
  if (working > 0) {
    const parts = [`${working} active`];
    if (queued > 0) {
      parts.push(`${queued} queued`);
    }
    if (done > 0) {
      parts.push(`${done}/${plan.agents.length} done`);
    }
    return parts.join(" · ");
  }
  if (done > 0) {
    return `${done}/${plan.agents.length} lanes done`;
  }
  return `${plan.agents.length} lane${plan.agents.length === 1 ? "" : "s"} queued`;
}

export function MultiAgentPlanEntry({
  details,
  planMessage,
  conversationMessages,
  conversationLocalId,
  onOpenWorkerRunTrace,
}: {
  details: Record<string, unknown> | null;
  planMessage?: ChatMessage | null;
  conversationMessages?: ChatMessage[] | null;
  conversationLocalId?: string | null;
  onOpenWorkerRunTrace?: (params: { jobId: string; title: string }) => void;
}) {
  const planDetails = normalizeMultiAgentPlanDetails(details) ?? normalizeMultiAgentPlanDetails(extractMetadata(planMessage));
  const plan = parseMultiAgentPlan(planDetails);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => {
    if (plan?.presentation.workerEvidenceVisibility !== "expanded") {
      return new Set();
    }
    return new Set(plan.agents.map((agent) => normalizeHandleKey(agent.handle || agent.label)));
  });
  const [expandedFullEvidenceRows, setExpandedFullEvidenceRows] = useState<Set<string>>(() => new Set());
  const [cancelGroupPending, setCancelGroupPending] = useState(false);
  const teamActivity = useMemo(
    () => collectTeamActivity({ planMessage, conversationMessages }),
    [conversationMessages, planMessage],
  );
  if (!plan) {
    return null;
  }

  const leadLabel = plan.leadHandle;
  const leadStatus = teamActivity.leadActivity?.status ?? "queued";
  const groupId = teamActivity.groupId;
  const hasActiveWorkers = plan.agents.some((agent) => {
    const handleKey = normalizeHandleKey(agent.handle || agent.label);
    const status = teamActivity.workerActivityByHandle.get(handleKey)?.status ?? "queued";
    return status === "queued" || status === "working";
  });
  const showCancelGroup = Boolean(groupId) && (hasActiveWorkers || leadStatus === "working");
  const handleCancelGroup = () => {
    if (!groupId || cancelGroupPending) {
      return;
    }
    setCancelGroupPending(true);
    void cancelPlanGroup(groupId)
      .catch((error) => {
        console.warn("[chat] failed to cancel plan group", error);
      })
      .finally(() => {
        setCancelGroupPending(false);
      });
  };
  const teamStatusSummary = formatTeamStatusSummary({
    plan,
    workerActivityByHandle: teamActivity.workerActivityByHandle,
    leadStatus,
  });
  const teamRuntimeSummary = formatTeamRuntimeSummary({
    plan,
    workerActivityByHandle: teamActivity.workerActivityByHandle,
  });
  const teamRuntimeDetail =
    teamRuntimeSummary?.title
      .split("\n")
      .slice(1)
      .join("\n")
      .trim() || teamRuntimeSummary?.title;

  const toggleEvidence = (handleKey: string) => {
    const wasExpanded = expandedRows.has(handleKey);
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(handleKey)) {
        next.delete(handleKey);
      } else {
        next.add(handleKey);
      }
      return next;
    });
    if (wasExpanded) {
      setExpandedFullEvidenceRows((current) => {
        const next = new Set(current);
        next.delete(handleKey);
        return next;
      });
    }
  };

  return (
    <div
      data-testid="multi-agent-inline-status"
      data-plan-mode={plan.mode}
      className="mt-2 flex max-w-full flex-wrap items-center gap-1.5 text-xs"
      aria-label={[teamStatusSummary, teamRuntimeSummary?.label].filter(Boolean).join("; ")}
    >
      {teamRuntimeSummary ? (
        <MenuTrigger>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            radius="full"
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-slate-50 px-2 py-1 font-medium text-slate-500 ring-1 ring-inset ring-slate-200 transition hover:bg-white hover:ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:bg-slate-900/60 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-900/80 dark:hover:ring-slate-500"
            title={teamRuntimeSummary.title}
            aria-label={`Workstreams; ${teamStatusSummary}; ${teamRuntimeSummary.label}`}
            data-testid="multi-agent-team-chip"
          >
            <GitBranch
              aria-hidden="true"
              className="h-3.5 w-3.5 flex-none -scale-x-100 text-primary-600 dark:text-primary-300"
            />
            <span>Workstreams</span>
          </Button>
          <StudioPopover placement="bottom start" offset={6} className="w-72 p-1.5">
            <div
              className="px-2 py-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-300"
              data-testid="multi-agent-team-runtime-summary"
            >
              <div className="font-medium text-slate-700 dark:text-slate-100">{teamRuntimeSummary.label}</div>
              <div className="mt-1 whitespace-pre-wrap text-xxs text-slate-500 dark:text-slate-400">
                {teamRuntimeDetail}
              </div>
            </div>
            <StudioMenu
              aria-label="Workstream actions"
              data-testid="multi-agent-team-menu"
              onAction={(key) => {
                if (String(key) === "copy-runtime-summary") {
                  copyText(teamRuntimeSummary.title);
                }
              }}
            >
              <StudioMenuSeparator />
              <StudioMenuItem id="copy-runtime-summary">
                <MenuItemContent>Copy runtime summary</MenuItemContent>
              </StudioMenuItem>
            </StudioMenu>
          </StudioPopover>
        </MenuTrigger>
      ) : (
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-full bg-slate-50 px-2 py-1 font-medium text-slate-500 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:ring-slate-700"
          title={teamStatusSummary}
          data-testid="multi-agent-team-chip"
        >
          <GitBranch
            aria-hidden="true"
            className="h-3.5 w-3.5 flex-none -scale-x-100 text-primary-600 dark:text-primary-300"
          />
          <span>Workstreams</span>
        </span>
      )}
      {plan.agents.map((agent) => {
        const handleKey = normalizeHandleKey(agent.handle || agent.label);
        const activity = teamActivity.workerActivityByHandle.get(handleKey) ?? null;
        const status = activity?.status ?? "queued";
        const isExpanded = expandedRows.has(handleKey);
        const isFullEvidenceExpanded = expandedFullEvidenceRows.has(handleKey);
        const canShowEvidence = plan.presentation.workerEvidenceVisibility !== "hidden";
        const canOpenRunTrace = Boolean(conversationLocalId && activity?.jobId && onOpenWorkerRunTrace);
        const isInteractive = canShowEvidence || canOpenRunTrace;
        const label = agent.handle || agent.label;
        const evidenceText = activity?.evidence ?? "";
        const compactEvidenceDetail = summarizeEvidenceDetail(evidenceText);
        const hasMoreEvidence = compactEvidenceDetail.endsWith("…");
        const evidenceDetail = isFullEvidenceExpanded ? evidenceText : compactEvidenceDetail;
        const leaseMetricsLabel = formatLeaseMetrics(
          activity?.leaseMetrics ?? null,
          activity?.toolUpdateCount ?? 0,
        );
        const actionLabel = canOpenRunTrace
          ? `Open run trace for ${label}; status ${statusLabel(status)}`
          : `${isExpanded ? "Hide" : "Show"} details for ${label}; status ${statusLabel(status)}`;
        const referenceText = formatWorkerReferenceText({
          label,
          status,
          agent,
          activity,
          leaseMetricsLabel,
        });
        return (
          <Fragment key={`${label}-${agent.scopeSummary}`}>
            <span
              className="group/agent-chip relative inline-flex min-w-0 max-w-full items-center"
              data-agent-write-mode={agent.writeMode}
              data-testid="multi-agent-chip-shell"
            >
              <button
                type="button"
                className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-1 font-medium ring-1 ring-inset transition ${statusChipClassName(status, isInteractive)}`}
                onClick={() => {
                  if (canOpenRunTrace && activity?.jobId) {
                    onOpenWorkerRunTrace?.({
                      jobId: activity.jobId,
                      title: `${label} run`,
                    });
                    return;
                  }
                  if (canShowEvidence) {
                    toggleEvidence(handleKey);
                  }
                }}
                disabled={!isInteractive}
                aria-expanded={canOpenRunTrace || !canShowEvidence ? undefined : isExpanded}
                aria-label={actionLabel}
                title={[agent.scopeSummary, leaseMetricsLabel?.title].filter(Boolean).join("\n") || actionLabel}
                data-testid="multi-agent-evidence-row"
                data-agent-handle={agent.handle}
              >
                <StatusGlyph status={status} />
                <span className="min-w-0 truncate">{label}</span>
              </button>
              <span className="pointer-events-none absolute -right-2 -top-2 z-10 opacity-0 transition group-focus-within/agent-chip:opacity-100 group-hover/agent-chip:opacity-100">
                <MenuTrigger>
                  <IconButton
                    variant="ghost"
                    radius="full"
                    size="xs"
                    aria-label={`More actions for ${label}`}
                    title={`More actions for ${label}`}
                    className="pointer-events-auto h-5 w-5 flex-none bg-white/95 text-slate-400 shadow-sm ring-1 ring-slate-200 hover:text-slate-700 dark:bg-slate-950/95 dark:text-slate-500 dark:ring-slate-700 dark:hover:text-slate-200"
                    data-testid="multi-agent-chip-menu-button"
                  >
                    <MoreHoriz aria-hidden="true" className="h-3.5 w-3.5" />
                  </IconButton>
                  <StudioPopover placement="bottom start" offset={6} className="w-52 p-1">
                    <StudioMenu
                      aria-label={`Actions for ${label}`}
                      data-testid="multi-agent-chip-menu"
                      onAction={(key) => {
                        const action = String(key);
                        if (action === "open" && activity?.jobId) {
                          onOpenWorkerRunTrace?.({
                            jobId: activity.jobId,
                            title: `${label} run`,
                          });
                          return;
                        }
                        if (action === "details" && canShowEvidence) {
                          toggleEvidence(handleKey);
                          return;
                        }
                        if (action === "copy-reference") {
                          copyText(referenceText);
                          return;
                        }
                        if (action === "copy-details") {
                          copyText(evidenceText);
                          return;
                        }
                        if (action === "copy-metrics") {
                          copyText(leaseMetricsLabel?.title ?? "");
                        }
                      }}
                    >
                      {canOpenRunTrace ? (
                        <StudioMenuItem id="open">
                          <MenuItemContent>Open run trace</MenuItemContent>
                        </StudioMenuItem>
                      ) : null}
                      {canShowEvidence ? (
                        <StudioMenuItem id="details">
                          <MenuItemContent>{isExpanded ? "Hide details" : "Show details"}</MenuItemContent>
                        </StudioMenuItem>
                      ) : null}
                      {(canOpenRunTrace || canShowEvidence) ? <StudioMenuSeparator /> : null}
                      <StudioMenuItem id="copy-reference">
                        <MenuItemContent>Copy reference</MenuItemContent>
                      </StudioMenuItem>
                      <StudioMenuItem id="copy-details" isDisabled={!evidenceText}>
                        <MenuItemContent>Copy details</MenuItemContent>
                      </StudioMenuItem>
                      <StudioMenuItem id="copy-metrics" isDisabled={!leaseMetricsLabel}>
                        <MenuItemContent>Copy metrics</MenuItemContent>
                      </StudioMenuItem>
                    </StudioMenu>
                  </StudioPopover>
                </MenuTrigger>
              </span>
            </span>
            {canShowEvidence && isExpanded ? (
              <div
                className="basis-full border-l border-primary-100/80 pl-3 text-xxs leading-relaxed text-slate-600 dark:border-primary-400/20 dark:text-slate-300"
                data-testid="multi-agent-evidence-detail"
              >
                {leaseMetricsLabel ? (
                  <div
                    className="mb-1 font-medium text-slate-500 dark:text-slate-400"
                    title={leaseMetricsLabel.title}
                    data-testid="multi-agent-runtime-metrics"
                  >
                    {leaseMetricsLabel.label}
                  </div>
                ) : null}
                {evidenceText ? (
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {evidenceDetail}
                    {hasMoreEvidence ? (
                      <button
                        type="button"
                        className="ml-1 inline-flex items-center text-xxs font-medium text-primary-700 hover:text-primary-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:text-primary-200 dark:hover:text-primary-100"
                        onClick={() => {
                          setExpandedFullEvidenceRows((current) => {
                            const next = new Set(current);
                            if (next.has(handleKey)) {
                              next.delete(handleKey);
                            } else {
                              next.add(handleKey);
                            }
                            return next;
                          });
                        }}
                        data-testid="multi-agent-evidence-full-toggle"
                      >
                        {isFullEvidenceExpanded ? "Less" : "Full note"}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div>No worker evidence has been posted yet.</div>
                )}
              </div>
            ) : null}
          </Fragment>
        );
      })}
      {leadLabel ? (
        <span
          className={`inline-flex min-w-0 max-w-full cursor-default items-center gap-1 rounded-full px-2 py-1 font-medium ring-1 ring-inset ${statusChipClassName(leadStatus, false)}`}
          aria-label={`Lead ${leadLabel}; status ${statusLabel(leadStatus)}`}
          data-testid="multi-agent-lead-status"
        >
          <StatusGlyph status={leadStatus} />
          <span className="min-w-0 truncate">{leadLabel}</span>
        </span>
      ) : null}
      {showCancelGroup ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          radius="full"
          className="inline-flex min-w-0 items-center gap-1 rounded-full bg-slate-50 px-2 py-1 font-medium text-slate-500 ring-1 ring-inset ring-slate-200 transition hover:bg-white hover:text-rose-600 hover:ring-rose-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:bg-slate-900/60 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-900/80 dark:hover:text-rose-300 dark:hover:ring-rose-400/40"
          onPress={handleCancelGroup}
          isDisabled={cancelGroupPending}
          title="Cancel remaining workstream jobs in this group"
          aria-label="Cancel group"
          data-testid="multi-agent-cancel-group"
        >
          Cancel group
        </Button>
      ) : null}
    </div>
  );
}
