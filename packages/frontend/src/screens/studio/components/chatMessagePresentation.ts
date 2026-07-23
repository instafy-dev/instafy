import { resolveLocalCapabilityArtifact } from "../../../capabilities/localCapabilityArtifactRegistry";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { isRecoverableRuntimeStartAlert as runtimeStartAlertIsRecoverable } from "./runtimeAlertPresentation";
import { normalizeAssistantStatusText } from "./assistantStatusHeuristics";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import { isGenericProgressLabel } from "./threadPreviewHelpers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalCapabilityStatusMessage(message: ChatMessage): boolean {
  const metadata = message.metadata && isRecord(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
  if (!metadata) {
    return false;
  }
  if (isRecord(metadata["localCapability"])) {
    return true;
  }
  const kind = typeof metadata["kind"] === "string" ? metadata["kind"].trim().toLowerCase() : "";
  return kind === "local_capability_result";
}

export function extractLocalCapabilityArtifact(message: ChatMessage) {
  return resolveLocalCapabilityArtifact(message);
}

export function extractLocalCapabilityLearnDraft(message: ChatMessage) {
  return extractLocalCapabilityArtifact(message)?.artifact.value ?? null;
}

export function extractAgentJobId(message: ChatMessage): string | null {
  if (!message.metadata || !isRecord(message.metadata)) {
    return null;
  }
  const candidates = [message.metadata["jobId"], message.metadata["job_id"], message.metadata["jobID"]];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function extractMultiAgentPlanMetadata(message: ChatMessage): Record<string, unknown> | null {
  if (!message.metadata || !isRecord(message.metadata)) {
    return null;
  }
  const candidates = [message.metadata["multiAgentPlan"], message.metadata["multi_agent_plan"]];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function extractMultiAgentPlanRole(message: ChatMessage): string | null {
  const plan = extractMultiAgentPlanMetadata(message);
  const role = typeof plan?.role === "string" ? plan.role.trim().toLowerCase() : "";
  return role || null;
}

function shouldHideMultiAgentWorkerMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant" || extractMultiAgentPlanRole(message) !== "worker") {
    return false;
  }
  return true;
}

function isMultiAgentPlanMessage(message: ChatMessage): boolean {
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType === "multi_agent_plan") {
    return true;
  }
  const plan = extractMultiAgentPlanMetadata(message);
  const planMessageType = typeof plan?.messageType === "string" ? plan.messageType.trim().toLowerCase() : "";
  return planMessageType === "multi_agent_plan";
}

function shouldHideByPresentationMetadata(message: ChatMessage): boolean {
  const metadata = message.metadata && isRecord(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
  const presentation = metadata?.presentation;
  if (isRecord(presentation) && presentation.hidden === true) {
    return true;
  }
  const details = metadata?.details;
  const nestedPresentation = isRecord(details) ? details.presentation : null;
  return isRecord(nestedPresentation) && nestedPresentation.hidden === true;
}

function shouldHideRedundantMultiAgentSetupSummary(
  message: ChatMessage,
  planJobIds: Set<string>,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType && messageType !== "status") {
    return false;
  }
  const jobId = extractAgentJobId(message);
  if (!jobId || !planJobIds.has(jobId)) {
    return false;
  }
  const metadata = message.metadata && isRecord(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
  const outcome = typeof metadata?.outcome === "string" ? metadata.outcome.trim().toLowerCase() : "";
  if (outcome === "failed" || outcome === "failure" || outcome === "error") {
    return false;
  }
  return true;
}

function shouldHideMultiAgentPlanJobLifecycleMessage(
  message: ChatMessage,
  planJobIds: Set<string>,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const jobId = extractAgentJobId(message);
  if (!jobId || !planJobIds.has(jobId) || isMultiAgentPlanMessage(message)) {
    return false;
  }
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (["command_execution", "mcp_tool_call", "reasoning", "status", "token_usage"].includes(messageType)) {
    return true;
  }
  const metadata = message.metadata && isRecord(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
  const kind = typeof metadata?.kind === "string" ? metadata.kind.trim().toLowerCase() : "";
  const outcome = typeof metadata?.outcome === "string" ? metadata.outcome.trim().toLowerCase() : "";
  return kind === "update" && (!outcome || outcome === "in_progress" || outcome === "running");
}

export function runMatchesThreadJobId(run: RunRecord, threadJobId: string): boolean {
  const normalizedThreadJobId = threadJobId.trim();
  if (!normalizedThreadJobId) {
    return false;
  }
  const metadata = run.metadata && isRecord(run.metadata) ? run.metadata : null;
  const candidates: unknown[] = [run.id];
  if (metadata) {
    candidates.push(metadata["jobId"], metadata["job_id"], metadata["jobID"], metadata["runId"], metadata["run_id"]);
    const details = metadata["details"];
    if (isRecord(details)) {
      candidates.push(details["jobId"], details["job_id"], details["jobID"], details["runId"], details["run_id"]);
    }
  }
  return candidates.some(
    (candidate) => typeof candidate === "string" && candidate.trim() === normalizedThreadJobId,
  );
}

function extractRunId(message: ChatMessage): string | null {
  const metadata = message.metadata && isRecord(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
  if (!metadata) {
    return null;
  }
  const candidates: unknown[] = [metadata["runId"], metadata["run_id"]];
  const details = metadata["details"];
  if (isRecord(details)) {
    candidates.push(details["runId"], details["run_id"]);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function isRecoverableRuntimeStartAlert(message: ChatMessage): boolean {
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType !== "runtime_alert") {
    return false;
  }
  const details = extractMessageDetails(message.metadata);
  const reason = typeof details?.reason === "string" ? details.reason.trim().toLowerCase() : "";
  if (reason !== "runtime_not_ready") {
    return false;
  }
  return runtimeStartAlertIsRecoverable(details, message.content);
}

export function isAgentStatusMessage(message: ChatMessage): boolean {
  if (!message.metadata || !isRecord(message.metadata)) {
    return false;
  }
  const sourceValue = message.metadata["source"];
  if (typeof sourceValue !== "string") {
    return false;
  }
  return sourceValue.trim().toLowerCase() === "agent";
}

export function shouldRenderLocalCapabilityStatusAsTimeline(message: ChatMessage): boolean {
  return isLocalCapabilityStatusMessage(message) && !extractLocalCapabilityArtifact(message);
}

export function shouldDisplayChatMessage(message: ChatMessage): boolean {
  const rawMessageType = getMessageType(message);
  const messageType = rawMessageType?.trim().toLowerCase() ?? null;
  if (shouldHideByPresentationMetadata(message)) {
    return false;
  }
  if (shouldHideMultiAgentWorkerMessage(message)) {
    return false;
  }
  if (message.role === "assistant" && isGenericProgressLabel(message.content)) {
    return false;
  }
  if (
    !messageType &&
    message.role === "assistant" &&
    message.metadata &&
    isRecord(message.metadata)
  ) {
    const source = typeof message.metadata.source === "string" ? message.metadata.source.trim().toLowerCase() : "";
    const kind = typeof message.metadata.kind === "string" ? message.metadata.kind.trim().toLowerCase() : "";
    const outcome =
      typeof message.metadata.outcome === "string" ? message.metadata.outcome.trim().toLowerCase() : "";
    if (source === "agent" && kind === "update" && outcome === "in_progress") {
      return false;
    }
    if (kind === "workspace_commit") {
      return false;
    }
    const details =
      isRecord(message.metadata.details) ? (message.metadata.details as Record<string, unknown>) : null;
    const detailsKind =
      details && typeof details.kind === "string" ? details.kind.trim().toLowerCase() : "";
    if (detailsKind === "workspace_commit") {
      return false;
    }
  }
  if (messageType === "reasoning") {
    return false;
  }
  if (
    messageType === "status" &&
    message.role === "assistant" &&
    !isLocalCapabilityStatusMessage(message)
  ) {
    return false;
  }
  if (messageType === "token_usage") {
    return false;
  }
  if (messageType === "file_change") {
    const hasAttachedFiles = Array.isArray(message.files) && message.files.length > 0;
    if (!hasAttachedFiles) {
      return false;
    }
  }
  if (messageType === "status" && isAgentStatusMessage(message)) {
    const normalized = normalizeAssistantStatusText(message.content).toLowerCase();
    const looksLikeDrafting = normalized.includes("drafting response");
    const looksLikeSummary = normalized.includes("response summary") && normalized.includes("prepar");
    if (looksLikeDrafting || looksLikeSummary) {
      return false;
    }
  }
  return true;
}

export function shouldDisplayJobThreadMessage(message: ChatMessage): boolean {
  if (shouldDisplayChatMessage(message)) {
    return true;
  }
  const role = extractMultiAgentPlanRole(message);
  if (message.role !== "assistant" || role !== "worker" || !message.content.trim()) {
    return false;
  }
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  return messageType !== "reasoning" && messageType !== "status" && messageType !== "token_usage";
}

export function collapseLifecycleMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const multiAgentPlanJobIds = new Set<string>();
  messages.forEach((message) => {
    if (!isMultiAgentPlanMessage(message)) {
      return;
    }
    const jobId = extractAgentJobId(message);
    if (jobId) {
      multiAgentPlanJobIds.add(jobId);
    }
  });

  const seen = new Set<string>();
  const runIdsWithLaterAgentOutput = new Set<string>();
  const next: ChatMessage[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageType = getMessageType(message);
    const normalizedMessageType = messageType?.trim().toLowerCase() ?? "";
    const runId = extractRunId(message);
    if (shouldHideMultiAgentPlanJobLifecycleMessage(message, multiAgentPlanJobIds)) {
      continue;
    }
    if (shouldHideRedundantMultiAgentSetupSummary(message, multiAgentPlanJobIds)) {
      continue;
    }
    // Older controllers persisted expected cold-start notices as standalone
    // assistant messages. The active run already owns this state through the
    // Octo typing/activity row, so keep these legacy notices out of the
    // transcript too. A reconnect failure remains visible and actionable.
    if (isRecoverableRuntimeStartAlert(message)) {
      continue;
    }
    if (normalizedMessageType === "runtime_alert" && runId && runIdsWithLaterAgentOutput.has(runId)) {
      continue;
    }
    if (messageType === "command_execution" || messageType === "mcp_tool_call") {
      const details = extractMessageDetails(message.metadata);
      const itemId = details && typeof details.itemId === "string" ? details.itemId.trim() : "";
      if (itemId) {
        const key = `${messageType}:${itemId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
    }
    if (
      message.role === "assistant" &&
      runId &&
      normalizedMessageType !== "runtime_alert" &&
      normalizedMessageType !== "run_cancellation"
    ) {
      const metadata = message.metadata && isRecord(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : null;
      const source = typeof metadata?.source === "string" ? metadata.source.trim().toLowerCase() : "";
      if (source !== "controller") {
        runIdsWithLaterAgentOutput.add(runId);
      }
    }
    next.push(message);
  }

  next.reverse();
  return next;
}

export function synthesizeAgentJobThreadMessages(
  collapsedAll: ChatMessage[],
  collapsedVisible: ChatMessage[],
): ChatMessage[] {
  const threadTriggerTypes = new Set([
    "command_execution",
    "mcp_tool_call",
    "todo_list",
    "file_change",
    "web_search",
    "error",
  ]);

  const multiAgentWorkerJobIds = new Set<string>();
  collapsedAll.forEach((message) => {
    if (extractMultiAgentPlanRole(message) !== "worker") {
      return;
    }
    const jobId = extractAgentJobId(message);
    if (jobId) {
      multiAgentWorkerJobIds.add(jobId);
    }
  });

  const threadStartMessageIdByJobId = new Map<string, string>();
  collapsedVisible.forEach((message) => {
    const jobId = extractAgentJobId(message);
    if (!jobId) {
      return;
    }
    if (multiAgentWorkerJobIds.has(jobId)) {
      return;
    }
    if (threadStartMessageIdByJobId.has(jobId)) {
      return;
    }
    const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
    const hasFileChanges = Array.isArray(message.files) && message.files.length > 0;
    if (hasFileChanges || threadTriggerTypes.has(messageType)) {
      threadStartMessageIdByJobId.set(jobId, message.id);
    }
  });

  if (threadStartMessageIdByJobId.size === 0 && multiAgentWorkerJobIds.size === 0) {
    return collapsedVisible;
  }

  const threadMessagesByJobId = new Map<string, ChatMessage[]>();

  collapsedAll.forEach((message) => {
    const jobId = extractAgentJobId(message);
    if (!jobId) {
      return;
    }
    if (!threadStartMessageIdByJobId.has(jobId)) {
      return;
    }
    const existing = threadMessagesByJobId.get(jobId);
    if (existing) {
      existing.push(message);
      return;
    }
    threadMessagesByJobId.set(jobId, [message]);
  });

  const output: ChatMessage[] = [];
  const insertedThreads = new Set<string>();

  collapsedVisible.forEach((message) => {
    const jobId = extractAgentJobId(message);
    if (!jobId) {
      output.push(message);
      return;
    }
    if (multiAgentWorkerJobIds.has(jobId)) {
      return;
    }
    const startMessageId = threadStartMessageIdByJobId.get(jobId);
    if (!startMessageId) {
      output.push(message);
      return;
    }
    if (message.id !== startMessageId && !insertedThreads.has(jobId)) {
      output.push(message);
      return;
    }
    if (insertedThreads.has(jobId)) {
      return;
    }

    insertedThreads.add(jobId);
    const threadMessages = threadMessagesByJobId.get(jobId) ?? [message];
    const startedAt = threadMessages.reduce((minTimestamp, candidate) => {
      if (typeof candidate.timestamp !== "number") {
        return minTimestamp;
      }
      return Math.min(minTimestamp, candidate.timestamp);
    }, message.timestamp);

    output.push({
      id: `agent-job-thread:${jobId}`,
      role: "assistant",
      content: "",
      timestamp: startedAt,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        jobId,
        threadMessages,
      },
    });
  });

  return output;
}
