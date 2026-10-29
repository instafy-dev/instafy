import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ChatBubbleQuestion, Check, Clock, GitBranch, MoreHoriz, Prohibition, ShieldQuestion, WarningTriangle } from "iconoir-react";
import { WarningTriangle as WarningTriangleSolid } from "iconoir-react/solid";
import { MenuTrigger } from "react-aria-components";
import { AiFace } from "../../../components/AiFace";
import { Button, IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Spinner } from "../../../components/Spinner";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { cancelPlanGroup, fetchPlanGroupStatus, type ControllerPlanGroupStatus } from "../../../services/runtimeController/jobs";
import type { ChatMessage } from "../types";
import type { RunRecord } from "../../../types";
import { aiFaceIdentityFromMetadata, withSavedAgentFace, type AiFaceIdentity } from "../../../utils/aiFace";
import { extractAgentJobId } from "./chatMessagePresentation";
import { collectPlanReruns, type PlanRerun } from "./planReruns";
import { PlanRerunNotice } from "./PlanRerunNotice";
import { ViewerAgentsContext } from "./viewerAgents";

// Supplied by the chat's existing hydrated run feed. Message bodies do not
// need to subscribe to composer/history providers or start separate polling.
export const MultiAgentRunsContext = createContext<{
  runs: Readonly<Record<string, RunRecord>>;
  scopeKey: string | null;
}>({ runs: {}, scopeKey: null });

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

type TeamActivityStatus = "queued" | "working" | "waiting" | "waiting_input" | "done" | "failed" | "canceled";

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
      const label = stringField(agent.label) || stringField(agent.title) || handle || "Task";
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

function extractMetadata(message?: Pick<ChatMessage, "metadata"> | null): Record<string, unknown> | null {
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

function extractAgentHandle(message: Pick<ChatMessage, "metadata">): string {
  const metadata = extractMetadata(message);
  const agent = extractNestedRecord(metadata, "agent", "agent");
  return normalizeHandleKey(agent?.handle);
}

function extractMultiAgentPlanMeta(message: Pick<ChatMessage, "metadata">): Record<string, unknown> | null {
  const metadata = extractMetadata(message);
  return extractNestedRecord(metadata, "multiAgentPlan", "multi_agent_plan");
}

function extractLeaseMetrics(message: Pick<ChatMessage, "metadata">): TeamLeaseMetrics | null {
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

function isCanceledMessage(message: ChatMessage): boolean {
  return ["canceled", "cancelled"].includes(extractMessageOutcome(message));
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
      const label = agent.label;
      const handleKey = normalizeHandleKey(agent.handle || label);
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
    agent.handle ? `agent: ${agent.handle}` : null,
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
  runs,
  declaredGroupId,
  leadHandle,
  snapshot,
}: {
  planMessage?: ChatMessage | null;
  conversationMessages?: ChatMessage[] | null;
  runs: Readonly<Record<string, RunRecord>>;
  declaredGroupId: string;
  leadHandle: string;
  snapshot: ControllerPlanGroupStatus | null;
}) {
  const planJobId = planMessage ? extractAgentJobId(planMessage) : null;
  const groupIds = new Set<string>(declaredGroupId ? [declaredGroupId] : []);
  const workerJobIds = new Set<string>();
  const workerHandleByJobId = new Map<string, string>();
  const workerMessagesByHandle = new Map<string, ChatMessage[]>();
  const leadMessages: ChatMessage[] = [];
  // Each lane's face for the card's legend (docs/Brand.md, "Octo's
  // hatchlings"): the seed the plan-group status reports for its newest job,
  // else the agent stamped on its newest loaded run, else on its newest
  // loaded message. A job the controller runs again keeps its face, so a
  // superseded job still names the lane's.
  const stampedFaceByHandle = new Map<string, AiFaceIdentity>();
  const statusSeedByHandle = new Map<string, string>();
  const noteStampedFace = (handle: string, source: Pick<ChatMessage, "metadata">) => {
    const stamped = aiFaceIdentityFromMetadata(source.metadata);
    if (stamped) stampedFaceByHandle.set(handle, stamped);
  };
  // The lead's face, the one its own rows wear: the agent stamped on its
  // newest loaded continuation run, else on its newest loaded message, else on
  // the plan message when the lead wrote it. A stamp under another handle is
  // another AI's.
  const leadKey = normalizeHandleKey(leadHandle);
  const leadStamp = (source: Pick<ChatMessage, "metadata">) => {
    const stamped = aiFaceIdentityFromMetadata(source.metadata);
    return stamped && leadKey && normalizeHandleKey(stamped.handle) === leadKey ? stamped : null;
  };
  let leadFace = planMessage ? leadStamp(planMessage) : null;
  const planRuns = Object.values(runs).filter(run => {
    const planMeta = extractMultiAgentPlanMeta(run);
    return declaredGroupId ? stringField(planMeta?.groupId) === declaredGroupId
      : Boolean(planJobId && stringField(planMeta?.parentJobId) === planJobId);
  }).sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
  for (const run of planRuns) {
    const groupId = stringField(extractMultiAgentPlanMeta(run)?.groupId);
    if (groupId) groupIds.add(groupId);
  }
  // A job the controller ran again (a continued turn, a rate-limit retry) is
  // not the lane's result: its rerun is, from whichever source names it.
  const reruns = collectPlanReruns([...planRuns, ...(conversationMessages ?? [])]);
  for (const worker of snapshot?.workers ?? []) {
    reruns.addStatus(worker.jobId, worker.retriedAs, worker.retriedFor);
  }

  for (const message of conversationMessages ?? []) {
    const planMeta = extractMultiAgentPlanMeta(message);
    if (!planMeta) {
      continue;
    }
    const role = stringField(planMeta.role).toLowerCase();
    const groupId = stringField(planMeta.groupId);
    const parentJobId = stringField(planMeta.parentJobId);
    const matchesParent = Boolean(planJobId && parentJobId === planJobId && (!declaredGroupId || groupId === declaredGroupId));
    if (matchesParent) {
      if (groupId) {
        groupIds.add(groupId);
      }
    }
    if (role === "worker" && matchesParent) {
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
        noteStampedFace(handle, message);
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
      Boolean(planJobId && parentJobId === planJobId && (!declaredGroupId || groupId === declaredGroupId)) || Boolean(groupId && groupIds.has(groupId));
    if (!belongsToPlan) {
      continue;
    }
    if (role === "worker") {
      const handle = extractAgentHandle(message);
      if (!handle) {
        continue;
      }
      noteStampedFace(handle, message);
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
  for (const message of leadMessages) leadFace = leadStamp(message) ?? leadFace;

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
      status = isCanceledMessage(terminalEvidence) ? "canceled" : isFailedMessage(terminalEvidence) ? "failed" : "done";
    } else if (isFailedMessage(latest)) {
      status = isCanceledMessage(latest) ? "canceled" : "failed";
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
  // Each lane's first job the controller ran again: the card says so once.
  const rerunByHandle = new Map<string, PlanRerun>();
  // A lane seen only through a job that was run again waits for its rerun.
  const supersededLane = (key: string, jobId: string | null | undefined): boolean => {
    const rerun = reruns.latest(jobId);
    if (!key || !rerun) return false;
    if (!rerunByHandle.has(key)) rerunByHandle.set(key, rerun);
    if (!workerActivityByHandle.has(key)) {
      workerActivityByHandle.set(key, {
        key, status: "queued", jobId: rerun.jobId, summary: "", evidence: "", leaseMetrics: null, toolUpdateCount: 0,
      });
    }
    return true;
  };
  for (const [handle, messages] of workerMessagesByHandle.entries()) {
    const activity = buildActivity(handle, messages.filter((message) => !reruns.isSuperseded(extractAgentJobId(message))));
    if (activity) {
      workerActivityByHandle.set(handle, activity);
    }
    for (const message of messages) supersededLane(handle, extractAgentJobId(message));
  }

  let leadActivity = buildActivity("lead", leadMessages);
  for (const worker of snapshot?.workers ?? []) {
    const key = normalizeHandleKey(worker.handle);
    const statusSeed = typeof worker.avatarSeed === "string" ? worker.avatarSeed : "";
    if (key && statusSeed.trim()) statusSeedByHandle.set(key, statusSeed);
    if (supersededLane(key, worker.jobId)) continue;
    const evidence = workerActivityByHandle.get(key);
    const status: TeamActivityStatus = worker.status === "leased" ? "working"
      : worker.status === "awaiting_input" ? "waiting_input"
      : worker.status === "completed" ? "done"
      : worker.status === "canceled" || worker.status === "cancelled" ? "canceled"
      : worker.status === "failed" || worker.status === "expired" ? "failed" : "queued";
    workerActivityByHandle.set(key, {
      key, status, jobId: worker.jobId,
      summary: evidence?.summary || summarizeEvidence(worker.summary ?? worker.lastMessage ?? ""),
      evidence: evidence?.evidence || formatEvidence(worker.summary ?? worker.lastMessage ?? ""),
      leaseMetrics: extractLeaseMetrics({ metadata: { leaseMetrics: worker.leaseMetrics } }) ?? evidence?.leaseMetrics ?? null,
      toolUpdateCount: evidence?.toolUpdateCount ?? 0,
    });
  }
  const workerRunHandles = new Set<string>();
  // Narrative evidence may arrive later, be compacted, or never exist for a
  // job canceled before its first lease. The persisted run is authoritative
  // for lifecycle and job identity, including after a page reload.
  for (const run of planRuns) {
    const role = stringField(extractMultiAgentPlanMeta(run)?.role).toLowerCase();
    const key = role === "worker" ? extractAgentHandle(run) : "lead";
    if (!key || (role !== "worker" && role !== "lead_continuation")) continue;
    const jobId = stringField(run.metadata?.jobId ?? run.metadata?.job_id);
    if (role === "worker") noteStampedFace(key, run);
    else leadFace = leadStamp(run) ?? leadFace;
    if (role === "worker" && supersededLane(key, jobId)) continue;
    const evidence = role === "worker" ? workerActivityByHandle.get(key) : leadActivity;
    const inputRequest = isRecord(run.metadata?.userInputRequest) ? run.metadata.userInputRequest : null;
    const awaitingInput = inputRequest?.status === "pending" || inputRequest?.status === "answered";
    // A completed provider turn may still be waiting for the person's answer.
    // Cancellation/failure always wins over a late or stale request marker.
    const status: TeamActivityStatus = run.status === "canceled" ? "canceled"
      : run.status === "failed" ? "failed"
      : awaitingInput ? "waiting_input"
      : inputRequest?.status === "expired" && (run.status === "success" || run.status === "merged") ? "failed"
      : run.status === "in_progress" ? "working"
      : run.status === "awaiting_approval" ? "waiting"
      : run.status === "success" || run.status === "merged" ? "done"
      : "queued";
    const activity: TeamActivity = {
      key, status, jobId: jobId || evidence?.jobId || "",
      summary: evidence?.summary || summarizeEvidence(run.lastMessage ?? ""),
      evidence: evidence?.evidence || formatEvidence(run.lastMessage ?? ""),
      leaseMetrics: extractLeaseMetrics(run) ?? evidence?.leaseMetrics ?? null,
      toolUpdateCount: evidence?.toolUpdateCount ?? 0,
    };
    if (role === "worker") {
      workerActivityByHandle.set(key, activity);
      workerRunHandles.add(key);
    }
    else leadActivity = activity;
  }

  // A status seed names the lane's face; the stamp it overrides still says
  // which agent ran it, so a saved agent's lane keeps its id.
  const workerFaceByHandle = new Map(stampedFaceByHandle);
  for (const [key, avatarSeed] of statusSeedByHandle) {
    workerFaceByHandle.set(key, { handle: key, avatarSeed, agentId: stampedFaceByHandle.get(key)?.agentId ?? null });
  }

  return {
    workerActivityByHandle,
    workerRunHandles,
    rerunByHandle,
    workerFaceByHandle,
    leadActivity,
    leadFace,
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
    case "canceled":
      return "canceled";
    case "waiting":
      return "waiting for approval";
    case "waiting_input":
      return "waiting for input";
    case "queued":
    default:
      return "queued";
  }
}

// A plan's face chips (its helpers and its lead) are the Machines agent chip
// around a 20px face (docs/Brand.md, "One rule for faces"): 2px of chip all
// round, so the corners are the tile's 6px + 2 = 8px, and no ring, so the
// tile's own hairline and shadow are the only edge inside the chip. The status
// slot at the far end mirrors the face's square.
const PLAN_CHIP_CLASS = "inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg p-0.5 font-medium";

// Workstreams' and Cancel group's touch target. Button gives every control a
// 44px box on a coarse pointer; here the box stays the chips' 24px, so a press,
// an open menu or a focus ring looks as it does with a mouse, and an invisible
// ::after takes the 44px instead: 10px above and below, 2px short of the 12px
// the row leaves on touch, so it never reaches a chip, a details panel, a rerun
// notice or the message text, on any line.
const PLAN_ROW_TOUCH_TARGET_CLASS = "relative pointer-coarse:!min-h-0 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2.5";

// One calm grey for every status; finished lanes recede. Status colour lives
// on the glyph alone (statusGlyphClassName). Hover is the shell's group-hover,
// so the chip stays lit while the pointer is on its "…". outline-hidden keeps
// a focus outline in forced colours, where the ring (a box-shadow) is dropped.
function statusChipClassName(status: TeamActivityStatus, interactive: boolean): string {
  const interactionClassName = interactive
    ? "cursor-pointer transition-colors group-hover/agent-chip:bg-slate-200 group-hover/agent-chip:text-slate-900 active:bg-slate-200 aria-expanded:bg-slate-200 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:group-hover/agent-chip:bg-white/10 dark:group-hover/agent-chip:text-slate-50 dark:active:bg-white/10 dark:aria-expanded:bg-white/10 dark:focus-visible:ring-offset-[var(--color-studio-dark-panel)]"
    : "cursor-default";
  switch (status) {
    case "done":
    case "canceled":
      return `bg-slate-50 text-slate-600 dark:bg-white/[0.05] dark:text-slate-400 ${interactionClassName}`;
    default:
      return `bg-slate-100 text-slate-700 dark:bg-white/[0.07] dark:text-slate-200 ${interactionClassName}`;
  }
}

// Grey, one step under the name, unless the person must act (amber) or
// something failed (rose). Those glyphs are darker than the grey ones in light
// and brighter in dark, and drawn heavier, so they stand out without hue too.
// Failed is the one solid glyph: to many colour-blind eyes this rose and amber
// are one olive, so weight, not hue, tells failed from waiting.
function statusGlyphClassName(status: TeamActivityStatus): string {
  switch (status) {
    case "failed":
      return "text-rose-700 dark:text-rose-300";
    case "waiting":
    case "waiting_input":
      return "text-amber-700 dark:text-amber-400";
    default:
      return "text-slate-600 dark:text-slate-500";
  }
}

// One shape per status, so the row reads in greyscale. Drawn after the name,
// never beside the face (a dot there read as the hatchling's own node).
function StatusGlyph({ status }: { status: TeamActivityStatus }) {
  switch (status) {
    case "working":
      return <Spinner size="xs" tone="current" aria-hidden="true" />;
    case "done":
      return <Check aria-hidden="true" className="h-3.5 w-3.5" />;
    case "failed":
      return <WarningTriangleSolid aria-hidden="true" className="h-3.5 w-3.5" />;
    case "waiting":
      return <ShieldQuestion aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5" />;
    case "waiting_input":
      return <ChatBubbleQuestion aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5" />;
    case "canceled":
      return <Prohibition aria-hidden="true" className="h-3.5 w-3.5" />;
    case "queued":
    default:
      return <Clock aria-hidden="true" className="h-3.5 w-3.5" />;
  }
}

// The glyph's 20px slot. On a lane (reveal) the "…" takes it while the chip is
// hovered, while the "…" has keyboard focus and while its menu is open; keyboard
// focus on the chip itself keeps the glyph, so the focused helper's status stays
// readable.
function StatusSlot({ status, reveal = false }: { status: TeamActivityStatus; reveal?: boolean }) {
  return (
    <span
      data-chip-status={status}
      className={`flex h-5 w-5 shrink-0 items-center justify-center ${statusGlyphClassName(status)}${
        reveal
          ? " transition-opacity group-hover/agent-chip:opacity-0 group-has-[[data-chip-menu]:focus-visible]/agent-chip:opacity-0 group-has-[[data-chip-menu][aria-expanded=true]]/agent-chip:opacity-0"
          : ""
      }`}
    >
      <StatusGlyph status={status} />
    </span>
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
  const queued = statuses.filter((status) => status === "queued").length;
  const canceled = statuses.filter((status) => status === "canceled").length;
  const waiting = statuses.filter((status) => status === "waiting").length;
  const waitingInput = statuses.filter((status) => status === "waiting_input").length;
  if (canceled || waiting || waitingInput) {
    return [
      leadStatus === "done" ? "Lead ready" : leadStatus === "working" ? "Lead active" : null,
      failed ? `${failed} need attention` : null,
      working ? `${working} active` : null,
      queued ? `${queued} queued` : null,
      waiting ? `${waiting} waiting for approval` : null,
      waitingInput ? `${waitingInput} waiting for input` : null,
      `${done}/${plan.agents.length} done`,
      canceled ? `${canceled} canceled` : null,
    ].filter(Boolean).join(" · ");
  }
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

// A touch or pen long-press on a lane opens that lane's "…" menu (touch has no
// hover, so the "…" never shows there). It is the gesture the chat already uses
// for a message's actions, so it stops the bubble's own long-press (and
// Android's long-press contextmenu) from also opening the message's menu, and
// swallows the click that ends it so the run trace does not open too. Mouse
// and keyboard are untouched: they have the "…".
function useLaneLongPress(openMenu: (handleKey: string) => void) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  // Once the lane's menu closes, the click that ends its long-press has come
  // or never will (Android sends none), so an activation with no press before
  // it, such as a screen reader's, goes through as well.
  const menuClosed = useCallback(() => {
    fired.current = false;
  }, []);
  const chipProps = useCallback((handleKey: string) => {
    const fire = (chip: HTMLButtonElement) => {
      clear();
      // A lane that left the plan mid-press opens nothing.
      if (!chip.isConnected) return;
      fired.current = true;
      // When the menu closes it hands focus back to whatever had it before
      // the press. A field (the composer, on a phone) gives it up now, as a
      // tap on the chip would make it, so its keyboard does not come back
      // then. Focusing the chip instead would ring it after a touch.
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea, select"))) {
        active.blur();
      }
      openMenu(handleKey);
    };
    // Only the pointer that started the press ends it, as only its moves
    // cancel it: a second finger lifting does not.
    const release = (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerId === origin.current?.pointerId) clear();
    };
    return {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        // Every new press starts clean: when the click that ends a long-press
        // never reaches the chip (the menu has taken focus, or Android sends
        // none), the next mouse, pen or touch activation must still go through.
        fired.current = false;
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        event.stopPropagation();
        clear();
        const chip = event.currentTarget;
        origin.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        timer.current = window.setTimeout(() => fire(chip), 420);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const start = origin.current;
        if (!start || event.pointerId !== start.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (dx * dx + dy * dy > 64) clear();
      },
      onPointerUp: release,
      onPointerCancel: release,
      // Enter or Space after a long-press: the same.
      onKeyDown: () => {
        fired.current = false;
      },
      onContextMenu: (event: MouseEvent<HTMLButtonElement>) => {
        if (!origin.current && !fired.current) return; // a mouse right-click keeps the message menu
        event.preventDefault();
        event.stopPropagation();
        if (!fired.current) fire(event.currentTarget);
      },
      onClickCapture: (event: MouseEvent<HTMLButtonElement>) => {
        if (!fired.current) return;
        fired.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }, [clear, openMenu]);
  return { chipProps, menuClosed };
}

function stopContextMenu(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
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
  const { runs, scopeKey } = useContext(MultiAgentRunsContext);
  const savedAgents = useContext(ViewerAgentsContext);
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
  const [groupSnapshot, setGroupSnapshot] = useState<{ key: string; value: ControllerPlanGroupStatus } | null>(null);
  const [openMenuHandle, setOpenMenuHandle] = useState<string | null>(null);
  const laneLongPress = useLaneLongPress(setOpenMenuHandle);
  const planMetadata = planMessage ? extractMultiAgentPlanMeta(planMessage) : null;
  const planRefused = stringField(planMetadata?.status) === "refused";
  const declaredGroupId = stringField(planMetadata?.groupId ?? planDetails?.groupId);
  const leadHandle = plan?.leadHandle ?? "";
  const liveActivity = useMemo(
    () => collectTeamActivity({ planMessage, conversationMessages, runs, declaredGroupId, leadHandle, snapshot: null }),
    [conversationMessages, planMessage, runs, declaredGroupId, leadHandle],
  );
  const groupId = liveActivity.groupId;
  const scopedSnapshot = groupSnapshot?.key === `${scopeKey}:${groupId}` ? groupSnapshot.value : null;
  const teamActivity = useMemo(() => scopedSnapshot
    ? collectTeamActivity({ planMessage, conversationMessages, runs, declaredGroupId, leadHandle, snapshot: scopedSnapshot })
    : liveActivity, [planMessage, conversationMessages, runs, declaredGroupId, leadHandle, scopedSnapshot, liveActivity]);
  const missingRuns = !planRefused && (plan?.agents.some(agent => !teamActivity.workerRunHandles.has(normalizeHandleKey(agent.handle || agent.label))) ?? false);
  useEffect(() => {
    if (!scopeKey || !groupId || !missingRuns) return;
    const abort = new AbortController();
    void fetchPlanGroupStatus(groupId, abort.signal).then(value => {
      if (!abort.signal.aborted && value) setGroupSnapshot({ key: `${scopeKey}:${groupId}`, value });
    }).catch(() => { /* Keep available history; an inaccessible group is never synthesized. */ });
    return () => abort.abort();
  }, [groupId, missingRuns, scopeKey]);
  if (planRefused) {
    return <div data-testid="multi-agent-plan-refused" role="status"
      className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
      <WarningTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
      <div><div className="font-medium">Workstreams did not start</div>
        <div>{stringField(planMetadata?.refusalReason) || "The requested workstream plan could not be started."}</div>
      </div>
    </div>;
  }
  if (!plan) {
    return null;
  }

  const leadLabel = plan.leadHandle;
  // The lead wears the face its own rows do, its current profile if it is one
  // of the viewer's saved agents, as a lane does.
  const leadFace = withSavedAgentFace(teamActivity.leadFace ?? { handle: leadLabel }, savedAgents);
  const leadStatus = teamActivity.leadActivity?.status ?? "queued";
  const hasActiveWorkers = plan.agents.some((agent) => {
    const handleKey = normalizeHandleKey(agent.handle || agent.label);
    const status = teamActivity.workerActivityByHandle.get(handleKey)?.status ?? "queued";
    return status === "queued" || status === "working" || status === "waiting" || status === "waiting_input";
  });
  const showCancelGroup = Boolean(groupId) && (hasActiveWorkers || leadStatus === "working" || leadStatus === "waiting" || leadStatus === "waiting_input");
  const handleCancelGroup = () => {
    if (!groupId || cancelGroupPending) {
      return;
    }
    setCancelGroupPending(true);
    void cancelPlanGroup(groupId)
      .then(result => {
        if (!result?.ok) return;
        // Successful cancellation also settles historical rows whose jobs
        // were outside the recent run feed. Reload reads the durable group.
        const canceled = new Set(result.canceledJobIds);
        setGroupSnapshot(current => current?.key === `${scopeKey}:${groupId}` ? {
          ...current, value: { ...current.value, workers: current.value.workers.map(worker => canceled.has(worker.jobId)
            ? { ...worker, status: "canceled" } : worker) },
        } : current);
      })
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
      className="mt-2 flex max-w-full flex-wrap items-center gap-1.5 text-xs pointer-coarse:mt-3 pointer-coarse:gap-y-3"
      aria-label={[teamStatusSummary, teamRuntimeSummary?.label].filter(Boolean).join("; ")}
    >
      {teamRuntimeSummary ? (
        <MenuTrigger>
          <Button
            type="button"
            variant="ghost"
            tone="muted"
            size="xs"
            radius="lg"
            // While its menu is open React Aria keeps it pressed, so it shows
            // Button's pressed fill then, as every menu button does.
            className={`min-w-0 !gap-1.5 pl-0.5 pr-1.5 text-slate-600 focus-visible:!outline-hidden focus-visible:!ring-primary-500 dark:focus-visible:!ring-offset-[var(--color-studio-dark-panel)] ${PLAN_ROW_TOUCH_TARGET_CLASS}`}
            title={teamRuntimeSummary.title}
            aria-label={`Workstreams; ${teamStatusSummary}; ${teamRuntimeSummary.label}`}
            data-testid="multi-agent-team-chip"
          >
            <GitBranch aria-hidden="true" className="h-3.5 w-3.5 flex-none -scale-x-100" />
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
          className="inline-flex min-w-0 items-center gap-1.5 py-1 pl-0.5 pr-1.5 font-medium text-slate-600 dark:text-slate-400"
          title={teamStatusSummary}
          data-testid="multi-agent-team-chip"
        >
          <GitBranch aria-hidden="true" className="h-3.5 w-3.5 flex-none -scale-x-100" />
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
        const label = agent.label;
        // A lane that ran as one of the viewer's own saved agents wears its
        // current profile, as its rows do in the transcript.
        const face = withSavedAgentFace(
          teamActivity.workerFaceByHandle.get(handleKey) ?? { handle: agent.handle || handleKey },
          savedAgents,
        );
        const taskIdentity = agent.handle && agent.handle !== label ? `${label} (${agent.handle})` : label;
        const evidenceText = activity?.evidence ?? "";
        const compactEvidenceDetail = summarizeEvidenceDetail(evidenceText);
        const hasMoreEvidence = compactEvidenceDetail.endsWith("…");
        const evidenceDetail = isFullEvidenceExpanded ? evidenceText : compactEvidenceDetail;
        const leaseMetricsLabel = formatLeaseMetrics(
          activity?.leaseMetrics ?? null,
          activity?.toolUpdateCount ?? 0,
        );
        const actionLabel = canOpenRunTrace
          ? `Open run trace for ${taskIdentity}; status ${statusLabel(status)}`
          : `${isExpanded ? "Hide" : "Show"} details for ${taskIdentity}; status ${statusLabel(status)}`;
        const referenceText = formatWorkerReferenceText({
          label,
          status,
          agent,
          activity,
          leaseMetricsLabel,
        });
        return (
          <Fragment key={handleKey || label}>
            <span
              className="group/agent-chip relative inline-flex min-w-0 max-w-full items-center"
              data-agent-write-mode={agent.writeMode}
              data-testid="multi-agent-chip-shell"
              // While the lane's menu is open, a contextmenu on it (a
              // right-click, or Android's long-press one where it outlasts the
              // 420ms that opened the menu and the finger is over the menu)
              // bubbles from that portal through here, and here it stops: it
              // must not reach the bubble and open the message's menu over the
              // lane's.
              onContextMenu={openMenuHandle === handleKey ? stopContextMenu : undefined}
            >
              <button
                type="button"
                className={`${PLAN_CHIP_CLASS} ${statusChipClassName(status, isInteractive)}`}
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
                {...laneLongPress.chipProps(handleKey)}
                disabled={!isInteractive}
                aria-expanded={canOpenRunTrace || !canShowEvidence ? undefined : isExpanded}
                aria-label={actionLabel}
                title={[`${taskIdentity} · ${statusLabel(status)}`, agent.scopeSummary, leaseMetricsLabel?.title].filter(Boolean).join("\n")}
                data-testid="multi-agent-evidence-row"
                data-agent-handle={agent.handle}
              >
                {/* The legend: the lane's face, the one its rows wear where no
                    name is printed (the typing row, branch rows). 20px, so the
                    chip keeps its height; the status follows the name, never
                    beside the face. */}
                <AiFace identity={face} className="mr-0.5 h-5 w-5" testId="multi-agent-chip-face" />
                <span className="min-w-0 truncate">{label}</span>
                <StatusSlot status={status} reveal />
              </button>
              <span className="pointer-events-none absolute inset-y-0.5 right-0.5 z-10 flex opacity-0 transition-opacity group-hover/agent-chip:opacity-100 has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                <MenuTrigger
                  isOpen={openMenuHandle === handleKey}
                  onOpenChange={(open) => {
                    setOpenMenuHandle(open ? handleKey : null);
                    if (!open) laneLongPress.menuClosed();
                  }}
                >
                  <IconButton
                    variant="ghost"
                    tone="neutral"
                    radius="md"
                    size="xs"
                    aria-label={`More actions for ${label}`}
                    title={`More actions for ${label}`}
                    // While its menu is open React Aria keeps the "…" pressed,
                    // so it shows its pressed fill then, as every menu button does.
                    className="pointer-events-none relative !h-5 !w-5 flex-none pointer-coarse:!min-h-0 pointer-coarse:!min-w-0 after:absolute after:-inset-0.5 group-hover/agent-chip:pointer-events-auto hover:!bg-slate-300/60 data-[hovered]:!bg-slate-300/60 data-[pressed]:!bg-slate-300 dark:hover:!bg-white/10 dark:data-[hovered]:!bg-white/10 dark:data-[pressed]:!bg-white/15 focus-visible:!outline-hidden focus-visible:!ring-primary-500 focus-visible:!ring-offset-0"
                    data-chip-menu=""
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
                        className="ml-1 inline-flex items-center text-xxs font-medium text-primary-700 hover:text-primary-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-200 dark:hover:text-primary-100"
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
          role="group"
          className={`${PLAN_CHIP_CLASS} ${statusChipClassName(leadStatus, false)}`}
          aria-label={`Lead ${leadLabel}; status ${statusLabel(leadStatus)}`}
          data-testid="multi-agent-lead-status"
        >
          <AiFace identity={leadFace} className="mr-0.5 h-5 w-5" testId="multi-agent-lead-face" />
          <span className="min-w-0 truncate">{leadLabel}</span>
          <StatusSlot status={leadStatus} />
        </span>
      ) : null}
      {showCancelGroup ? (
        <Button
          type="button"
          variant="ghost"
          tone="muted"
          size="xs"
          radius="lg"
          className={`min-w-0 pl-1 pr-1.5 text-slate-600 data-[hovered]:!text-rose-700 dark:data-[hovered]:!text-rose-300 focus-visible:!outline-hidden focus-visible:!ring-primary-500 dark:focus-visible:!ring-offset-[var(--color-studio-dark-panel)] ${PLAN_ROW_TOUCH_TARGET_CLASS}`}
          onPress={handleCancelGroup}
          isDisabled={cancelGroupPending}
          title="Cancel remaining workstream jobs in this group"
          aria-label="Cancel group"
          data-testid="multi-agent-cancel-group"
        >
          Cancel group
        </Button>
      ) : null}
      {plan.agents.map((agent) => {
        const handleKey = normalizeHandleKey(agent.handle || agent.label);
        const rerun = teamActivity.rerunByHandle.get(handleKey);
        if (!rerun) return null;
        const label = agent.label;
        return (
          <PlanRerunNotice
            key={`rerun-${handleKey}`}
            subject={label}
            rerun={rerun}
            className="basis-full"
            onOpen={conversationLocalId && onOpenWorkerRunTrace
              ? (jobId) => onOpenWorkerRunTrace({ jobId, title: `${label} run` })
              : null}
          />
        );
      })}
    </div>
  );
}
