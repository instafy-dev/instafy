import { mergeAndSortMessages } from "../../../conversations/conversationMessageUtils";
import { isAwaitingLeaseRunStale, isRunActivelyProgressing } from "../../../conversations/runLiveness";
import type { RunRecord } from "../../../types";
import { extractControllerConversationNoticeStatus } from "./controllerConversationNotice";
import type { ChatMessage } from "../types";

const THREAD_TERMINAL_RUN_STATUSES = new Set(["success", "failed", "canceled", "merged"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: string | null | undefined): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRunTimestamp(run: RunRecord): number {
  return Math.max(parseTimestamp(run.updatedAt), parseTimestamp(run.createdAt), 0);
}

function extractMessageStatus(message: ChatMessage): string | null {
  const controllerNoticeStatus = extractControllerConversationNoticeStatus(message);
  if (controllerNoticeStatus) {
    return controllerNoticeStatus;
  }
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = metadata && isRecord(metadata["details"]) ? metadata["details"] : null;
  const candidates: unknown[] = [
    metadata?.["status"],
    metadata?.["outcome"],
    details?.["status"],
    details?.["outcome"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim().toLowerCase();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function resolveLatestTerminalThreadOutcome(
  threadMessages: ChatMessage[],
): { status: string; timestamp: number } | null {
  let latestTerminal: { status: string; timestamp: number } | null = null;

  for (const message of threadMessages) {
    if (message.role !== "assistant") {
      continue;
    }
    const status = extractMessageStatus(message);
    if (!status || !THREAD_TERMINAL_RUN_STATUSES.has(status)) {
      continue;
    }
    const timestamp =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : Number.NEGATIVE_INFINITY;
    if (!latestTerminal || timestamp >= latestTerminal.timestamp) {
      latestTerminal = { status, timestamp };
    }
  }

  return latestTerminal;
}

function resolveTerminalRunFallbackText(status: RunRecord["status"]): string {
  switch (status) {
    case "failed":
      return "Run failed.";
    case "canceled":
      return "Run canceled.";
    case "merged":
      return "Run merged.";
    case "success":
    default:
      return "Completed.";
  }
}

function synthesizeTerminalThreadMessage(run: RunRecord, jobId: string): ChatMessage {
  const normalizedStatus = run.status.trim().toLowerCase();
  const content = run.lastMessage?.trim() || resolveTerminalRunFallbackText(run.status);
  return {
    id: `thread-preview-terminal:${run.id}`,
    role: "assistant",
    authorId: null,
    content,
    timestamp: resolveRunTimestamp(run),
    files: null,
    metadata: {
      source: "agent",
      kind: "result",
      outcome: normalizedStatus,
      status: normalizedStatus,
      jobId: jobId.trim() || run.id,
      runId: run.id,
    },
  };
}

function normalizeJobId(jobId: string): string {
  return jobId.trim();
}

function shouldMatchAnyRun(jobId: string): boolean {
  const normalized = normalizeJobId(jobId);
  return !normalized || normalized.startsWith("thread:");
}

export function resolveLatestConversationRun(
  runs: Record<string, RunRecord> | null | undefined,
  conversationControllerId: string | null | undefined,
): RunRecord | null {
  const normalizedConversationId = typeof conversationControllerId === "string" ? conversationControllerId.trim() : "";
  if (!normalizedConversationId) {
    return null;
  }
  let latestRun: RunRecord | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const run of Object.values(runs ?? {})) {
    if (run.conversationId !== normalizedConversationId) {
      continue;
    }
    const timestamp = resolveRunTimestamp(run);
    if (!latestRun || timestamp >= latestTimestamp) {
      latestRun = run;
      latestTimestamp = timestamp;
    }
  }
  return latestRun;
}

export function resolveThreadPreviewMessages(params: {
  threadMessages: ChatMessage[];
  conversationControllerId: string | null | undefined;
  runs: Record<string, RunRecord> | null | undefined;
  jobId: string;
}): ChatMessage[] {
  const latestRun = resolveLatestConversationRun(params.runs, params.conversationControllerId);
  if (!latestRun || !THREAD_TERMINAL_RUN_STATUSES.has(latestRun.status)) {
    return params.threadMessages;
  }

  const latestTerminalThreadOutcome = resolveLatestTerminalThreadOutcome(params.threadMessages);
  if (
    latestTerminalThreadOutcome &&
    latestTerminalThreadOutcome.timestamp >= resolveRunTimestamp(latestRun)
  ) {
    return params.threadMessages;
  }

  const terminalLastMessage = latestRun.lastMessage?.trim() ?? "";
  if (
    terminalLastMessage &&
    params.threadMessages.some(
      (message) => message.role === "assistant" && message.content.trim() === terminalLastMessage,
    )
  ) {
    return params.threadMessages;
  }

  return mergeAndSortMessages([
    ...params.threadMessages,
    synthesizeTerminalThreadMessage(latestRun, params.jobId),
  ]);
}

export function isThreadPreviewRunInFlight(params: {
  jobId: string;
  pendingRunIds: string[];
  awaitingLeaseRunIds: string[];
  pendingRunSubmittedAt: Record<string, number>;
  runs: Record<string, RunRecord> | null | undefined;
  conversationControllerId: string | null | undefined;
  nowMs?: number;
  matchesRunToJobId: (run: RunRecord, jobId: string) => boolean;
}): boolean {
  const normalizedJobId = normalizeJobId(params.jobId);
  const matchAnyRun = shouldMatchAnyRun(normalizedJobId);
  const awaitingLeaseRunIds = new Set(params.awaitingLeaseRunIds);
  const nowMs = params.nowMs ?? Date.now();

  const pendingRunMatchesJob = (pendingRunId: string) =>
    matchAnyRun || pendingRunId.trim() === normalizedJobId;
  const activeRunMatchesJob = (run: RunRecord) =>
    matchAnyRun || params.matchesRunToJobId(run, normalizedJobId);

  if (normalizedJobId && params.pendingRunIds.some((pendingRunId) => pendingRunId === normalizedJobId)) {
    const directRun = params.runs?.[normalizedJobId];
    if (!directRun) {
      return (
        awaitingLeaseRunIds.has(normalizedJobId) &&
        !isAwaitingLeaseRunStale(params.pendingRunSubmittedAt[normalizedJobId], nowMs)
      );
    }
    if (isRunActivelyProgressing(directRun, nowMs)) {
      return true;
    }
  }

  for (const pendingRunId of params.pendingRunIds) {
    if (!pendingRunMatchesJob(pendingRunId)) {
      continue;
    }
    const pendingRun = params.runs?.[pendingRunId];
    if (pendingRun && isRunActivelyProgressing(pendingRun, nowMs) && activeRunMatchesJob(pendingRun)) {
      return true;
    }
    if (
      !pendingRun &&
      awaitingLeaseRunIds.has(pendingRunId) &&
      !isAwaitingLeaseRunStale(params.pendingRunSubmittedAt[pendingRunId], nowMs)
    ) {
      return true;
    }
  }

  const normalizedConversationId =
    typeof params.conversationControllerId === "string" ? params.conversationControllerId.trim() : "";
  if (!normalizedConversationId) {
    return false;
  }

  return Object.values(params.runs ?? {}).some(
    (run) =>
      run.conversationId === normalizedConversationId &&
      isRunActivelyProgressing(run, nowMs) &&
      activeRunMatchesJob(run),
  );
}
