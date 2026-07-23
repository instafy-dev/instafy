import type { ChatMessage } from "../screens/studio/types";

export type ConversationGoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  | "canceled";

export interface ConversationGoal {
  id: string;
  objective: string;
  status: ConversationGoalStatus;
  doneWhen: string | null;
  stopWhen: string | null;
  progressSummary: string | null;
  parentGoalId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export type GoalCommand =
  | { kind: "show" }
  | { kind: "set"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "complete"; progressSummary: string | null }
  | { kind: "block"; progressSummary: string | null }
  | { kind: "cancel"; progressSummary: string | null }
  | { kind: "clear" };

export interface GoalCommandResult {
  goal: ConversationGoal | null;
  message: string;
  changed: boolean;
}

export interface GoalCommandDispatch {
  input: string;
  continuationTurn: number | null;
}

const CONVERSATION_GOAL_METADATA_KEY = "instafyGoal";
const GOAL_COMMAND_PREFIX = "/goal";
export const DEFAULT_GOAL_CONTINUATION_MAX_TURNS = 100;
const LEGACY_NON_RECOVERABLE_AI_REQUEST_GOAL_SUMMARY =
  "AI request failed because credits or provider quota are unavailable.";
export const NON_RECOVERABLE_AI_REQUEST_GOAL_SUMMARY =
  "AI request is blocked by upstream provider quota or rate limits.";

export function normalizeConversationGoalProgressSummaryForDisplay(
  summary: string | null | undefined,
): string | null {
  const normalized = normalizeNullableString(summary);
  if (normalized === LEGACY_NON_RECOVERABLE_AI_REQUEST_GOAL_SUMMARY) {
    return NON_RECOVERABLE_AI_REQUEST_GOAL_SUMMARY;
  }
  return normalized;
}

export interface GoalContinuationDecision {
  shouldContinue: boolean;
  nextTurn: number;
  reason:
    | "continue"
    | "no_active_goal"
    | "run_not_successful"
    | "run_goal_mismatch"
    | "run_messages_pending"
    | "goal_run_already_pending"
    | "goal_continuation_already_requested"
    | "terminal_goal_update_observed"
    | "turn_limit_reached"
    | "stagnation_detected";
  stagnation: GoalStagnationAssessment | null;
}

export interface GoalRunLike {
  id: string;
  status: string;
  metadata?: Record<string, unknown> | null;
}

export interface GoalConversationLike {
  localId: string;
  controllerId: string | null;
  activeGoal: ConversationGoal | null;
  messages?: ChatMessage[];
}

export interface GoalConversationRunLike extends GoalRunLike {
  conversationId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface GoalStagnationAssessment {
  level: "none" | "warning" | "blocked";
  reason:
    | "none"
    | "repeated_assistant_output"
    | "low_activity_continuations";
  summary: string | null;
}

export interface ConversationGoalHealth {
  turnCount: number;
  maxTurns: number;
  label: string;
  detail: string | null;
  tone: "active" | "paused" | "warning" | "blocked";
  progressRatio: number;
  stagnation: GoalStagnationAssessment;
}

export interface GoalRunSignal {
  runId: string;
  turn: number | null;
  assistantText: string | null;
  hasActivity: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeString(value);
}

function normalizeGoalStatus(value: unknown): ConversationGoalStatus | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (
    normalized === "active" ||
    normalized === "paused" ||
    normalized === "completed" ||
    normalized === "blocked" ||
    normalized === "canceled"
  ) {
    return normalized;
  }
  return null;
}

function normalizeMessageType(value: unknown): string | null {
  return normalizeString(value)?.toLowerCase() ?? null;
}

function resolveGoalActionDetails(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  const directDetails = isPlainObject(metadata.details) ? metadata.details : metadata;
  let resolved: Record<string, unknown> = directDetails;
  for (let depth = 0; depth < 3; depth += 1) {
    const nestedDetails = isPlainObject(resolved.details) ? resolved.details : null;
    if (!nestedDetails) {
      break;
    }
    const hasWrapperShape =
      typeof resolved.runtimeId === "string" ||
      typeof resolved.runtime_id === "string" ||
      typeof resolved.displayName === "string" ||
      typeof resolved.display_name === "string" ||
      typeof resolved.messageType === "string" ||
      typeof resolved.message_type === "string" ||
      normalizeMessageType(resolved.kind) === "runtime_selection";
    if (!hasWrapperShape) {
      break;
    }
    resolved = nestedDetails;
  }
  return resolved;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeGoalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `goal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function extractConversationGoalFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ConversationGoal | null {
  if (!isPlainObject(metadata)) {
    return null;
  }
  return normalizeConversationGoal(
    metadata[CONVERSATION_GOAL_METADATA_KEY] ?? metadata.instafy_goal,
  );
}

export function normalizeConversationGoal(value: unknown): ConversationGoal | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const objective = normalizeString(value.objective);
  if (!objective) {
    return null;
  }
  const status = normalizeGoalStatus(value.status) ?? "active";
  const createdAt = normalizeString(value.createdAt ?? value.created_at) ?? nowIso();
  const updatedAt = normalizeString(value.updatedAt ?? value.updated_at) ?? createdAt;
  return {
    id: normalizeString(value.id) ?? makeGoalId(),
    objective,
    status,
    doneWhen: normalizeNullableString(value.doneWhen ?? value.done_when),
    stopWhen: normalizeNullableString(value.stopWhen ?? value.stop_when),
    progressSummary: normalizeNullableString(
      value.progressSummary ?? value.progress_summary,
    ),
    parentGoalId: normalizeNullableString(value.parentGoalId ?? value.parent_goal_id),
    createdAt,
    updatedAt,
    createdBy: normalizeNullableString(value.createdBy ?? value.created_by),
    updatedBy: normalizeNullableString(value.updatedBy ?? value.updated_by),
  };
}

export function createConversationGoalMetadataPatch(
  goal: ConversationGoal | null,
): Record<string, unknown> {
  return {
    [CONVERSATION_GOAL_METADATA_KEY]: goal,
  };
}

export function createConversationGoal(
  objective: string,
  userId: string | null,
): ConversationGoal {
  const timestamp = nowIso();
  return {
    id: makeGoalId(),
    objective: objective.trim(),
    status: "active",
    doneWhen: null,
    stopWhen: null,
    progressSummary: null,
    parentGoalId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: userId,
    updatedBy: userId,
  };
}

export function updateConversationGoal(
  goal: ConversationGoal,
  patch: Partial<
    Pick<
      ConversationGoal,
      "objective" | "status" | "doneWhen" | "stopWhen" | "progressSummary"
    >
  >,
  userId: string | null,
): ConversationGoal {
  return {
    ...goal,
    ...patch,
    objective: patch.objective?.trim() ?? goal.objective,
    updatedAt: nowIso(),
    updatedBy: userId,
  };
}

export function conversationGoalsEqual(
  first: ConversationGoal | null,
  second: ConversationGoal | null,
): boolean {
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}

function isTerminalGoalStatus(status: ConversationGoalStatus): boolean {
  return status === "completed" || status === "blocked" || status === "canceled";
}

function isSameGoalIdentity(
  first: ConversationGoal,
  second: ConversationGoal,
): boolean {
  if (first.id && second.id && first.id === second.id) {
    return true;
  }
  return first.objective === second.objective;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function goalRunTimestamp(run: GoalConversationRunLike): number {
  return timestampMs(run.updatedAt) ?? timestampMs(run.createdAt) ?? 0;
}

export function shouldApplyConversationGoalSnapshot(
  currentGoal: ConversationGoal | null,
  incomingGoal: ConversationGoal | null,
): boolean {
  if (conversationGoalsEqual(currentGoal, incomingGoal)) {
    return false;
  }
  if (!currentGoal || !incomingGoal) {
    return true;
  }
  if (
    isTerminalGoalStatus(currentGoal.status) &&
    !isTerminalGoalStatus(incomingGoal.status) &&
    isSameGoalIdentity(currentGoal, incomingGoal)
  ) {
    const currentUpdatedAt = timestampMs(currentGoal.updatedAt);
    const incomingUpdatedAt = timestampMs(incomingGoal.updatedAt);
    if (!currentUpdatedAt || !incomingUpdatedAt || incomingUpdatedAt <= currentUpdatedAt) {
      return false;
    }
  }
  return true;
}

export function parseGoalCommand(input: string): GoalCommand | null {
  const trimmed = input.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered !== GOAL_COMMAND_PREFIX && !lowered.startsWith(`${GOAL_COMMAND_PREFIX} `)) {
    return null;
  }
  const rest = trimmed.slice(GOAL_COMMAND_PREFIX.length).trim();
  if (!rest) {
    return { kind: "show" };
  }
  const [rawCommand = "", ...restParts] = rest.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = restParts.join(" ").trim();

  if (command === "pause") {
    return { kind: "pause" };
  }
  if (command === "resume") {
    return { kind: "resume" };
  }
  if (command === "clear") {
    return { kind: "clear" };
  }
  if (command === "cancel") {
    return { kind: "cancel", progressSummary: argument || null };
  }
  if (command === "complete" || command === "done") {
    return { kind: "complete", progressSummary: argument || null };
  }
  if (command === "block" || command === "blocked") {
    return { kind: "block", progressSummary: argument || null };
  }
  if (command === "edit") {
    return argument ? { kind: "edit", objective: argument } : { kind: "show" };
  }

  return { kind: "set", objective: rest };
}

export function applyGoalCommand(
  currentGoal: ConversationGoal | null,
  command: GoalCommand,
  userId: string | null,
): GoalCommandResult {
  switch (command.kind) {
    case "show":
      if (!currentGoal) {
        return {
          goal: currentGoal,
          changed: false,
          message: "No active goal. Use `/goal <objective>` to start one.",
        };
      }
      return {
        goal: currentGoal,
        changed: false,
        message: `Goal is ${currentGoal.status}: ${currentGoal.objective}`,
      };
    case "set": {
      const goal = createConversationGoal(command.objective, userId);
      return {
        goal,
        changed: true,
        message: `Goal started: ${goal.objective}`,
      };
    }
    case "edit": {
      const goal = currentGoal
        ? updateConversationGoal(
            currentGoal,
            { objective: command.objective, status: "active" },
            userId,
          )
        : createConversationGoal(command.objective, userId);
      return {
        goal,
        changed: true,
        message: `Goal updated: ${goal.objective}`,
      };
    }
    case "pause":
      if (!currentGoal) {
        return {
          goal: null,
          changed: false,
          message: "No goal to pause.",
        };
      }
      return {
        goal: updateConversationGoal(currentGoal, { status: "paused" }, userId),
        changed: true,
        message: "Goal paused.",
      };
    case "resume":
      if (!currentGoal) {
        return {
          goal: null,
          changed: false,
          message: "No goal to resume.",
        };
      }
      return {
        goal: updateConversationGoal(currentGoal, { status: "active" }, userId),
        changed: true,
        message: "Goal resumed.",
      };
    case "complete":
      if (!currentGoal) {
        return {
          goal: null,
          changed: false,
          message: "No goal to complete.",
        };
      }
      return {
        goal: updateConversationGoal(
          currentGoal,
          { status: "completed", progressSummary: command.progressSummary },
          userId,
        ),
        changed: true,
        message: command.progressSummary
          ? `Goal completed: ${command.progressSummary}`
          : "Goal completed.",
      };
    case "block":
      if (!currentGoal) {
        return {
          goal: null,
          changed: false,
          message: "No goal to block.",
        };
      }
      return {
        goal: updateConversationGoal(
          currentGoal,
          { status: "blocked", progressSummary: command.progressSummary },
          userId,
        ),
        changed: true,
        message: command.progressSummary
          ? `Goal blocked: ${command.progressSummary}`
          : "Goal blocked.",
      };
    case "cancel":
      if (!currentGoal) {
        return {
          goal: null,
          changed: false,
          message: "No goal to cancel.",
        };
      }
      return {
        goal: updateConversationGoal(
          currentGoal,
          { status: "canceled", progressSummary: command.progressSummary },
          userId,
        ),
        changed: true,
        message: "Goal canceled.",
      };
    case "clear":
      return {
        goal: null,
        changed: currentGoal !== null,
        message: currentGoal ? "Goal cleared." : "No goal to clear.",
      };
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return {
        goal: currentGoal,
        changed: false,
        message: "Unsupported goal command.",
      };
    }
  }
}

export function activeGoalPromptMetadata(
  goal: ConversationGoal | null,
): Record<string, unknown> | null {
  if (!goal || goal.status !== "active") {
    return null;
  }
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    doneWhen: goal.doneWhen,
    stopWhen: goal.stopWhen,
    progressSummary: goal.progressSummary,
    parentGoalId: goal.parentGoalId,
  };
}

function extractGoalMetadataId(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return normalizeString(value.id ?? value.goalId ?? value.goal_id);
}

function resolvePromptMetadataRecord(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  if (isPlainObject(metadata.prompt_metadata)) {
    return metadata.prompt_metadata;
  }
  if (isPlainObject(metadata.promptMetadata)) {
    return metadata.promptMetadata;
  }
  return null;
}

function extractMessageRunId(message: ChatMessage): string | null {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  return normalizeString(metadata?.runId ?? metadata?.run_id);
}

function extractPromptGoalId(message: ChatMessage): string | null {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const promptMetadata = resolvePromptMetadataRecord(metadata);
  return extractGoalMetadataId(promptMetadata?.goal) ?? extractGoalMetadataId(metadata?.goal);
}

export function runMetadataMatchesConversationGoal(
  runMetadata: Record<string, unknown> | null | undefined,
  goal: ConversationGoal | null,
): boolean {
  if (!goal || goal.status !== "active") {
    return false;
  }
  return extractGoalMetadataId(runMetadata?.goal) === goal.id;
}

function isGoalUpdateMessage(message: ChatMessage): boolean {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const messageType =
    normalizeMessageType(message.messageType) ??
    normalizeMessageType(metadata?.messageType) ??
    normalizeMessageType(metadata?.message_type);
  return message.role === "assistant" && messageType === "goal_update";
}

function goalUpdateMessageMatchesGoal(message: ChatMessage, goal: ConversationGoal): boolean {
  if (!isGoalUpdateMessage(message)) {
    return false;
  }
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const details = resolveGoalActionDetails(metadata);
  const clear =
    normalizeMessageType(details?.operation) === "clear" ||
    normalizeMessageType(details?.op) === "clear";
  if (clear) {
    return false;
  }
  const status = normalizeGoalStatus(details?.status);
  if (status && status !== "active") {
    return false;
  }
  const goalId = extractGoalMetadataId(details?.goal) ?? extractGoalMetadataId(metadata?.goal);
  if (goalId) {
    return goalId === goal.id;
  }
  const objective = normalizeString(details?.objective);
  return objective === goal.objective;
}

function isTerminalGoalUpdateMessage(message: ChatMessage): boolean {
  if (!isGoalUpdateMessage(message)) {
    return false;
  }
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const details = resolveGoalActionDetails(metadata);
  const status = normalizeGoalStatus(details?.status);
  const clear =
    normalizeMessageType(details?.operation) === "clear" ||
    normalizeMessageType(details?.op) === "clear";
  return clear || status === "completed" || status === "blocked" || status === "canceled";
}

function runProducedActiveGoalUpdate(
  run: GoalRunLike,
  messages: ChatMessage[] | undefined,
  goal: ConversationGoal | null,
): boolean {
  if (!goal || goal.status !== "active" || !messages?.length) {
    return false;
  }
  return messages.some(
    (message) =>
      extractMessageRunId(message) === run.id && goalUpdateMessageMatchesGoal(message, goal),
  );
}

function runProducedTerminalGoalUpdate(
  run: GoalRunLike,
  messages: ChatMessage[] | undefined,
): boolean {
  if (!messages?.length) {
    return false;
  }
  return messages.some(
    (message) => extractMessageRunId(message) === run.id && isTerminalGoalUpdateMessage(message),
  );
}

function runProducedAnyMessage(
  run: GoalRunLike,
  messages: ChatMessage[] | undefined,
): boolean {
  if (!messages?.length) {
    return false;
  }
  return messages.some((message) => extractMessageRunId(message) === run.id);
}

function runMatchesConversationGoal(
  run: GoalRunLike,
  messages: ChatMessage[] | undefined,
  goal: ConversationGoal | null,
): boolean {
  return (
    runMetadataMatchesConversationGoal(run.metadata, goal) ||
    runProducedActiveGoalUpdate(run, messages, goal)
  );
}

export function selectLatestSuccessfulGoalRuns<T extends GoalConversationRunLike>(args: {
  conversations: GoalConversationLike[];
  runs: T[];
}): T[] {
  const conversationsByControllerId = new Map<string, GoalConversationLike>();
  args.conversations.forEach((conversation) => {
    if (conversation.controllerId) {
      conversationsByControllerId.set(conversation.controllerId, conversation);
    }
  });

  const latestByGoal = new Map<string, T>();
  args.runs.forEach((run) => {
    if (run.status.trim().toLowerCase() !== "success" || !run.conversationId) {
      return;
    }
    const conversation = conversationsByControllerId.get(run.conversationId);
    if (!conversation?.activeGoal) {
      return;
    }
    if (!runMatchesConversationGoal(run, conversation.messages, conversation.activeGoal)) {
      return;
    }
    const key = `${conversation.localId}:${conversation.activeGoal.id}`;
    const existing = latestByGoal.get(key);
    if (!existing || goalRunTimestamp(run) >= goalRunTimestamp(existing)) {
      latestByGoal.set(key, run);
    }
  });

  return Array.from(latestByGoal.values()).sort(
    (first, second) => goalRunTimestamp(first) - goalRunTimestamp(second),
  );
}

function resolveGoalContinuationRecord(message: ChatMessage): Record<string, unknown> | null {
  if (message.role !== "user") {
    return null;
  }
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const promptMetadata = resolvePromptMetadataRecord(metadata);
  return isPlainObject(metadata?.goalContinuation)
    ? metadata.goalContinuation
    : isPlainObject(metadata?.goal_continuation)
      ? metadata.goal_continuation
      : isPlainObject(promptMetadata?.goalContinuation)
        ? promptMetadata.goalContinuation
        : isPlainObject(promptMetadata?.goal_continuation)
          ? promptMetadata.goal_continuation
          : null;
}

function extractGoalContinuationTurn(message: ChatMessage): number | null {
  const continuation = resolveGoalContinuationRecord(message);
  const rawTurn = continuation?.turn ?? continuation?.attempt;
  return typeof rawTurn === "number" && Number.isFinite(rawTurn) && rawTurn > 0
    ? Math.floor(rawTurn)
    : null;
}

function extractGoalContinuationTriggerRunId(message: ChatMessage): string | null {
  const continuation = resolveGoalContinuationRecord(message);
  return normalizeString(continuation?.triggerRunId ?? continuation?.trigger_run_id);
}

function hasContinuationRequestedForRun(
  messages: ChatMessage[],
  goalId: string,
  runId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      extractPromptGoalId(message) === goalId &&
      extractGoalContinuationTriggerRunId(message) === runId,
  );
}

function isGoalRunActivityMessage(message: ChatMessage): boolean {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const messageType =
    normalizeMessageType(message.messageType) ??
    normalizeMessageType(metadata?.messageType) ??
    normalizeMessageType(metadata?.message_type);
  return (
    messageType === "command_execution" ||
    messageType === "mcp_tool_call" ||
    Boolean(message.files?.length)
  );
}

function isGoalRunVisibleAssistantText(message: ChatMessage): boolean {
  if (message.role !== "assistant" || !message.content.trim()) {
    return false;
  }
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const messageType =
    normalizeMessageType(message.messageType) ??
    normalizeMessageType(metadata?.messageType) ??
    normalizeMessageType(metadata?.message_type);
  return ![
    "command_execution",
    "error",
    "goal_update",
    "mcp_tool_call",
    "reasoning",
    "runtime_alert",
    "status",
    "token_usage",
  ].includes(messageType ?? "");
}

function normalizeAssistantProgressText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function truncateGoalEvidence(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function collectGoalRunSignals(
  messages: ChatMessage[],
  goalId: string,
): GoalRunSignal[] {
  const goalRunIds = new Set<string>();
  const goalRunTurns = new Map<string, number | null>();
  messages.forEach((message) => {
    if (message.role !== "user" || extractPromptGoalId(message) !== goalId) {
      return;
    }
    const runId = extractMessageRunId(message);
    if (runId) {
      goalRunIds.add(runId);
      goalRunTurns.set(runId, extractGoalContinuationTurn(message));
    }
  });

  const runs = new Map<string, GoalRunSignal>();
  const ensureRun = (runId: string) => {
    const existing = runs.get(runId);
    if (existing) {
      return existing;
    }
    const next = {
      runId,
      turn: goalRunTurns.get(runId) ?? null,
      assistantText: null,
      hasActivity: false,
    };
    runs.set(runId, next);
    return next;
  };

  messages.forEach((message) => {
    const runId = extractMessageRunId(message);
    if (!runId || !goalRunIds.has(runId)) {
      return;
    }
    const run = ensureRun(runId);
    if (isGoalRunActivityMessage(message)) {
      run.hasActivity = true;
    }
    if (isGoalRunVisibleAssistantText(message)) {
      run.assistantText = message.content.trim();
    }
  });

  return Array.from(runs.values());
}

export function buildGoalReviewContext(args: {
  goal: ConversationGoal | null;
  messages: ChatMessage[];
  maxSignals?: number;
}): string | null {
  if (!args.goal || args.goal.status !== "active") {
    return null;
  }
  const signals = collectGoalRunSignals(args.messages, args.goal.id)
    .filter((signal) => signal.turn !== null || signal.assistantText || signal.hasActivity)
    .slice(-(args.maxSignals ?? 3));
  if (signals.length === 0) {
    return null;
  }

  const lines = ["Recent automatic goal-loop evidence:"];
  signals.forEach((signal, index) => {
    const label = signal.turn ? `turn ${signal.turn}` : `recent run ${index + 1}`;
    const activity = signal.hasActivity ? "tool/file activity observed" : "no tool/file activity observed";
    const assistantText = signal.assistantText
      ? truncateGoalEvidence(signal.assistantText)
      : "no visible assistant result";
    lines.push(`- ${label}: ${activity}; assistant result: ${assistantText}`);
  });
  return lines.join("\n");
}

export function assessGoalStagnation(args: {
  goal: ConversationGoal | null;
  messages: ChatMessage[];
}): GoalStagnationAssessment {
  if (!args.goal || args.goal.status !== "active") {
    return { level: "none", reason: "none", summary: null };
  }
  const continuationTurns = countGoalContinuationTurns(args.messages, args.goal.id);
  if (continuationTurns < 3) {
    return { level: "none", reason: "none", summary: null };
  }

  const runSignals = collectGoalRunSignals(args.messages, args.goal.id);
  const recentTextRuns = runSignals
    .map((signal) => signal.assistantText)
    .filter((text): text is string => Boolean(text));
  const lastThreeTexts = recentTextRuns.slice(-3).map(normalizeAssistantProgressText);
  const lastTwoTexts = lastThreeTexts.slice(-2);
  const repeatedLastTwo =
    lastTwoTexts.length === 2 && lastTwoTexts[0].length > 0 && lastTwoTexts[0] === lastTwoTexts[1];
  const repeatedLastThree =
    lastThreeTexts.length === 3 &&
    lastThreeTexts[0].length > 0 &&
    lastThreeTexts.every((text) => text === lastThreeTexts[0]);

  if (repeatedLastThree && continuationTurns >= 5) {
    return {
      level: "blocked",
      reason: "repeated_assistant_output",
      summary:
        "Stopped because several automatic goal turns repeated the same assistant output without completing or blocking the goal.",
    };
  }
  if (repeatedLastTwo) {
    return {
      level: "warning",
      reason: "repeated_assistant_output",
      summary:
        "Recent automatic goal turns look repetitive. The next turn should complete, block, or change strategy.",
    };
  }

  const recentRuns = runSignals.slice(-3);
  const recentRunsHaveNoActivity =
    recentRuns.length >= 3 && recentRuns.every((signal) => !signal.hasActivity);
  const recentTextsAreBrief =
    recentTextRuns.slice(-3).length >= 3 &&
    recentTextRuns.slice(-3).every((text) => text.length < 160);
  if (continuationTurns >= 5 && recentRunsHaveNoActivity && recentTextsAreBrief) {
    return {
      level: "warning",
      reason: "low_activity_continuations",
      summary:
        "The goal has used several automatic turns with little observable activity. The next turn should reassess the plan.",
    };
  }

  return { level: "none", reason: "none", summary: null };
}

export function countGoalContinuationTurns(
  messages: ChatMessage[],
  goalId: string,
): number {
  let highestTurn = 0;
  messages.forEach((message) => {
    if (extractPromptGoalId(message) !== goalId) {
      return;
    }
    const turn = extractGoalContinuationTurn(message);
    if (turn && turn > highestTurn) {
      highestTurn = turn;
    }
  });
  return highestTurn;
}

function appendGoalExecutionGuidance(lines: string[]): void {
  lines.push(
    "",
    "Use available tools or project context when they can materially advance the goal.",
    "If the goal asks for inspection, verification, implementation, or debugging, gather relevant safe evidence before declaring it blocked.",
    "Automatic goal loops can call you again while the goal stays active; do partial useful work and leave the goal active when later turns can continue it.",
    "If the goal explicitly requires work across multiple assistant turns, do the next useful step in this turn and keep the goal active; do not block just because this run can only emit one final response.",
    "Do not block only because no evidence has been gathered yet; block only when the required capability/resource is unavailable, unsafe, or cannot be reached from this runtime.",
  );
}

export function buildGoalStartPrompt(args: { goal: ConversationGoal }): string {
  const lines = [
    `Start the active goal: ${args.goal.objective}`,
    "",
    "Work toward the goal now.",
  ];
  appendGoalExecutionGuidance(lines);
  lines.push(
    "",
    "If the goal is complete, emit a goal_update with status completed and summarize the evidence. If you are blocked, emit a goal_update with status blocked and explain the concrete blocker.",
  );
  return lines.join("\n");
}

export function buildGoalContinuationPrompt(args: {
  goal: ConversationGoal;
  turn: number;
  maxTurns?: number;
  stagnation?: GoalStagnationAssessment | null;
  messages?: ChatMessage[];
}): string {
  const maxTurns = args.maxTurns ?? DEFAULT_GOAL_CONTINUATION_MAX_TURNS;
  const lines = [
    `Continue the active goal: ${args.goal.objective}`,
    "",
    `This is automatic goal continuation turn ${args.turn} of ${maxTurns}.`,
  ];
  const reviewContext = args.messages
    ? buildGoalReviewContext({ goal: args.goal, messages: args.messages })
    : null;
  if (reviewContext) {
    lines.push("", reviewContext);
  }
  if (args.stagnation?.level === "warning" && args.stagnation.summary) {
    lines.push("", `Goal health warning: ${args.stagnation.summary}`);
  }
  lines.push(
    "",
    "Before doing more work, review whether the last automatic turns materially advanced the goal.",
    "- If the goal is already satisfied, emit a completed goal_update and summarize the evidence.",
    "- If the next action cannot materially advance the goal, emit a blocked goal_update with the concrete blocker.",
    "- If recent turns repeated or had low activity, change strategy before continuing; do not repeat the same answer or command.",
  );
  appendGoalExecutionGuidance(lines);
  lines.push(
    "Do meaningful remaining work now. If the goal is complete, emit a goal_update with status completed. If you are blocked, emit a goal_update with status blocked and explain the blocker. Do not repeat completed work.",
  );
  return lines.join("\n");
}

export function buildGoalUnblockHelpPrompt(args: {
  goal: ConversationGoal;
  blocker?: string | null;
}): string {
  const blocker = normalizeString(args.blocker) ?? "No blocker details were reported.";
  return [
    "Help me unblock this goal.",
    "",
    `Goal: ${args.goal.objective}`,
    `Blocked because: ${blocker}`,
    "",
    "Please explain the blocker, identify the next concrete step, and say whether I should resume, change strategy, or clear the goal.",
    "Do not resume or change the goal automatically unless I ask.",
  ].join("\n");
}

export function decideGoalContinuation(args: {
  goal: ConversationGoal | null;
  terminalRun: GoalRunLike;
  messages: ChatMessage[];
  pendingRuns: GoalRunLike[];
  maxTurns?: number;
}): GoalContinuationDecision {
  const maxTurns = args.maxTurns ?? DEFAULT_GOAL_CONTINUATION_MAX_TURNS;
  const goal = args.goal;
  if (!goal || goal.status !== "active") {
    return { shouldContinue: false, nextTurn: 0, reason: "no_active_goal", stagnation: null };
  }
  if (args.terminalRun.status.trim().toLowerCase() !== "success") {
    return { shouldContinue: false, nextTurn: 0, reason: "run_not_successful", stagnation: null };
  }
  const runGoalId = extractGoalMetadataId(args.terminalRun.metadata?.goal);
  if (
    (!runGoalId || runGoalId !== goal.id) &&
    !runProducedActiveGoalUpdate(args.terminalRun, args.messages, goal)
  ) {
    return { shouldContinue: false, nextTurn: 0, reason: "run_goal_mismatch", stagnation: null };
  }
  if (hasContinuationRequestedForRun(args.messages, goal.id, args.terminalRun.id)) {
    return { shouldContinue: false, nextTurn: 0, reason: "goal_continuation_already_requested", stagnation: null };
  }
  const hasPendingGoalRun = args.pendingRuns.some((run) => {
    const status = run.status.trim().toLowerCase();
    if (status === "success" || status === "failed" || status === "canceled") {
      return false;
    }
    return extractGoalMetadataId(run.metadata?.goal) === goal.id;
  });
  if (hasPendingGoalRun) {
    return { shouldContinue: false, nextTurn: 0, reason: "goal_run_already_pending", stagnation: null };
  }
  if (!runProducedAnyMessage(args.terminalRun, args.messages)) {
    return { shouldContinue: false, nextTurn: 0, reason: "run_messages_pending", stagnation: null };
  }
  if (runProducedTerminalGoalUpdate(args.terminalRun, args.messages)) {
    return { shouldContinue: false, nextTurn: 0, reason: "terminal_goal_update_observed", stagnation: null };
  }
  const nextTurn = countGoalContinuationTurns(args.messages, goal.id) + 1;
  if (nextTurn > maxTurns) {
    return { shouldContinue: false, nextTurn, reason: "turn_limit_reached", stagnation: null };
  }
  const stagnation = assessGoalStagnation({ goal, messages: args.messages });
  if (stagnation.level === "blocked") {
    return {
      shouldContinue: false,
      nextTurn,
      reason: "stagnation_detected",
      stagnation,
    };
  }
  return { shouldContinue: true, nextTurn, reason: "continue", stagnation };
}

export function buildConversationGoalHealth(args: {
  goal: ConversationGoal | null;
  messages: ChatMessage[];
  maxTurns?: number;
}): ConversationGoalHealth | null {
  const goal = args.goal;
  if (!goal) {
    return null;
  }
  const maxTurns = args.maxTurns ?? DEFAULT_GOAL_CONTINUATION_MAX_TURNS;
  const turnCount = countGoalContinuationTurns(args.messages, goal.id);
  const progressRatio = Math.min(1, Math.max(0, turnCount / maxTurns));
  const stagnation = assessGoalStagnation({ goal, messages: args.messages });

  if (goal.status === "blocked") {
    return {
      turnCount,
      maxTurns,
      label: "Blocked",
      detail: goal.progressSummary,
      tone: "blocked",
      progressRatio,
      stagnation,
    };
  }
  if (goal.status === "paused") {
    return {
      turnCount,
      maxTurns,
      label: "Paused",
      detail: goal.progressSummary,
      tone: "paused",
      progressRatio,
      stagnation,
    };
  }
  if (goal.status !== "active") {
    return null;
  }
  if (stagnation.level === "warning") {
    return {
      turnCount,
      maxTurns,
      label: "Needs reassessment",
      detail: stagnation.summary,
      tone: "warning",
      progressRatio,
      stagnation,
    };
  }
  return {
    turnCount,
    maxTurns,
    label: turnCount > 0 ? `Turn ${turnCount}/${maxTurns}` : "Working",
    detail: null,
    tone: "active",
    progressRatio,
    stagnation,
  };
}

function hasNonRecoverableAiRequestFailure(value: unknown): boolean {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("insufficient_quota") ||
    normalized.includes("rate_limit_error") ||
    normalized.includes("rate limit reached")
  );
}

function messageErrorSignals(message: ChatMessage): unknown[] {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const details = isPlainObject(metadata?.details) ? metadata.details : null;
  const event = isPlainObject(details?.event) ? details.event : null;
  return [
    message.content,
    metadata?.errorMessage,
    metadata?.error_message,
    details?.message,
    event?.message,
  ];
}

export function isNonRecoverableRunErrorMessage(
  message: ChatMessage,
  runId: string | null = null,
): boolean {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const messageType =
    normalizeMessageType(message.messageType) ??
    normalizeMessageType(metadata?.messageType) ??
    normalizeMessageType(metadata?.message_type);
  if (message.role !== "assistant" || messageType !== "error") {
    return false;
  }
  if (runId && extractMessageRunId(message) !== runId) {
    return false;
  }
  return messageErrorSignals(message).some(hasNonRecoverableAiRequestFailure);
}

export function hasNonRecoverableErrorForRun(
  messages: ChatMessage[],
  runId: string,
  currentGoal: ConversationGoal | null = null,
): boolean {
  if (messages.some((message) => isNonRecoverableRunErrorMessage(message, runId))) {
    return true;
  }
  if (!currentGoal) {
    return false;
  }
  return messages.some((message) => {
    if (!isNonRecoverableRunErrorMessage(message) || extractMessageRunId(message)) {
      return false;
    }
    const latestUserMessage = latestUserMessageBeforeError(messages, message);
    return (
      latestUserMessage !== null &&
      extractMessageRunId(latestUserMessage) === runId &&
      extractPromptGoalId(latestUserMessage) === currentGoal.id
    );
  });
}

function resolveNonRecoverableGoalErrorMatch(args: {
  currentGoal: ConversationGoal | null;
  existingMessages: ChatMessage[];
  errorMessage: ChatMessage;
}): { matches: boolean; runId: string | null } {
  const { currentGoal, existingMessages, errorMessage } = args;
  if (!currentGoal || currentGoal.status !== "active") {
    return { matches: false, runId: null };
  }
  if (!isNonRecoverableRunErrorMessage(errorMessage)) {
    return { matches: false, runId: null };
  }
  const failedRunId = extractMessageRunId(errorMessage);
  if (failedRunId) {
    const matches = existingMessages.some(
      (message) =>
        message.role === "user" &&
        extractMessageRunId(message) === failedRunId &&
        extractPromptGoalId(message) === currentGoal.id,
    );
    return { matches, runId: matches ? failedRunId : null };
  }
  const latestUserMessage = latestUserMessageBeforeError(existingMessages, errorMessage);
  const matches =
    latestUserMessage !== null && extractPromptGoalId(latestUserMessage) === currentGoal.id;
  return {
    matches,
    runId: matches ? extractMessageRunId(latestUserMessage) : null,
  };
}

export function resolveNonRecoverableGoalErrorRunId(
  currentGoal: ConversationGoal | null,
  existingMessages: ChatMessage[],
  errorMessage: ChatMessage,
): string | null {
  return resolveNonRecoverableGoalErrorMatch({
    currentGoal,
    existingMessages,
    errorMessage,
  }).runId;
}

export function settleGoalAfterTerminalRun(
  currentGoal: ConversationGoal | null,
  runMetadata: Record<string, unknown> | null | undefined,
  runStatus: string,
  userId: string | null,
): { goal: ConversationGoal | null; changed: boolean } {
  if (!currentGoal || currentGoal.status !== "active") {
    return { goal: currentGoal, changed: false };
  }
  const normalizedStatus = runStatus.trim().toLowerCase();
  if (normalizedStatus !== "failed" && normalizedStatus !== "canceled") {
    return { goal: currentGoal, changed: false };
  }
  const runGoalId = extractGoalMetadataId(runMetadata?.goal);
  if (!runGoalId || runGoalId !== currentGoal.id) {
    return { goal: currentGoal, changed: false };
  }
  const nextGoal = updateConversationGoal(
    currentGoal,
    {
      status: normalizedStatus === "canceled" ? "canceled" : "blocked",
      progressSummary:
        normalizedStatus === "canceled"
          ? "Run was canceled before the goal completed."
          : "Run failed before the goal completed.",
    },
    userId,
  );
  return { goal: nextGoal, changed: true };
}

export function settleGoalAfterNonRecoverableRunError(
  currentGoal: ConversationGoal | null,
  existingMessages: ChatMessage[],
  errorMessage: ChatMessage,
  userId: string | null,
): { goal: ConversationGoal | null; changed: boolean } {
  const match = resolveNonRecoverableGoalErrorMatch({
    currentGoal,
    existingMessages,
    errorMessage,
  });
  if (!match.matches || !currentGoal) {
    return { goal: currentGoal, changed: false };
  }
  return {
    goal: updateConversationGoal(
      currentGoal,
      {
        status: "blocked",
        progressSummary: NON_RECOVERABLE_AI_REQUEST_GOAL_SUMMARY,
      },
      userId,
    ),
    changed: true,
  };
}

function latestUserMessageBeforeError(
  existingMessages: ChatMessage[],
  errorMessage: ChatMessage,
): ChatMessage | null {
  let latestUserMessage: ChatMessage | null = null;
  for (const message of existingMessages) {
    if (message.id === errorMessage.id) {
      break;
    }
    if (message.role !== "user") {
      continue;
    }
    if (
      Number.isFinite(errorMessage.timestamp) &&
      Number.isFinite(message.timestamp) &&
      message.timestamp > errorMessage.timestamp
    ) {
      continue;
    }
    latestUserMessage = message;
  }
  return latestUserMessage;
}

export function resolveGoalCommandDispatchInput(
  command: GoalCommand,
  goal: ConversationGoal | null,
): string | null {
  return resolveGoalCommandDispatch({ command, goal })?.input ?? null;
}

export function resolveGoalCommandDispatch(args: {
  command: GoalCommand;
  goal: ConversationGoal | null;
  messages?: ChatMessage[];
}): GoalCommandDispatch | null {
  const { command, goal } = args;
  if ((command.kind === "set" || command.kind === "edit") && goal?.status === "active") {
    return {
      input: buildGoalStartPrompt({ goal }),
      continuationTurn: null,
    };
  }
  if (command.kind === "resume" && goal?.status === "active") {
    const messages = args.messages ?? [];
    const continuationTurn = countGoalContinuationTurns(messages, goal.id) + 1;
    return {
      input: buildGoalContinuationPrompt({
        goal,
        turn: continuationTurn,
        messages,
      }),
      continuationTurn,
    };
  }
  return null;
}

export function applyGoalActionMessage(
  currentGoal: ConversationGoal | null,
  message: ChatMessage,
  userId: string | null,
): { goal: ConversationGoal | null; changed: boolean } {
  const metadata = isPlainObject(message.metadata) ? message.metadata : null;
  const messageType =
    normalizeMessageType(message.messageType) ??
    normalizeMessageType(metadata?.messageType) ??
    normalizeMessageType(metadata?.message_type);
  if (messageType !== "goal_update") {
    return { goal: currentGoal, changed: false };
  }
  const details = resolveGoalActionDetails(metadata);
  const status = normalizeGoalStatus(details?.status);
  const objective = normalizeString(details?.objective);
  const progressSummary = normalizeNullableString(
    details?.progressSummary ?? details?.progress_summary ?? message.content,
  );
  const doneWhen = normalizeNullableString(details?.doneWhen ?? details?.done_when);
  const stopWhen = normalizeNullableString(details?.stopWhen ?? details?.stop_when);
  const clear =
    normalizeMessageType(details?.operation) === "clear" ||
    normalizeMessageType(details?.op) === "clear";

  if (clear) {
    return { goal: null, changed: currentGoal !== null };
  }

  if (!currentGoal && objective) {
    const goal = createConversationGoal(objective, userId);
    return {
      goal: updateConversationGoal(
        goal,
        {
          status: status ?? "active",
          progressSummary,
          doneWhen,
          stopWhen,
        },
        userId,
      ),
      changed: true,
    };
  }

  if (!currentGoal) {
    return { goal: currentGoal, changed: false };
  }

  const nextGoal = updateConversationGoal(
    currentGoal,
    {
      ...(objective ? { objective } : {}),
      ...(status ? { status } : {}),
      ...(progressSummary ? { progressSummary } : {}),
      ...(doneWhen ? { doneWhen } : {}),
      ...(stopWhen ? { stopWhen } : {}),
    },
    userId,
  );
  return {
    goal: nextGoal,
    changed: !conversationGoalsEqual(currentGoal, nextGoal),
  };
}
