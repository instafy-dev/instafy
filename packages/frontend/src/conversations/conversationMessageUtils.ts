import type {
  ChatMessage,
  ChatMessageCommitRange,
  ChatMessageFileChange,
  ChatMessageFileChangeType,
  ChatMessageFileLineRange,
  ChatMessageFileNotSaved,
  ChatMessageNotSavedReason,
  ChatMessageUnsavedReason,
} from "../screens/studio/types";
import type { ControllerConversationMessage } from "../sdk/instafy";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIMELINE_MESSAGE_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "runtime_switch",
  "todo_list",
  "file_change",
  "web_search",
  "token_usage",
  "reasoning",
]);

function normalizeMessageTypeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePromptMetadataRecord(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  if (isPlainObject(metadata["prompt_metadata"])) {
    return metadata["prompt_metadata"] as Record<string, unknown>;
  }
  if (isPlainObject(metadata["promptMetadata"])) {
    return metadata["promptMetadata"] as Record<string, unknown>;
  }
  return metadata;
}

function resolveClientMessageIdFromMetadata(
  metadata: Record<string, unknown> | null,
): string | null {
  const promptMetadata = resolvePromptMetadataRecord(metadata);
  const raw = firstNonEmptyString([
    metadata?.["clientMessageId"],
    metadata?.["client_message_id"],
    promptMetadata?.["clientMessageId"],
    promptMetadata?.["client_message_id"],
  ]);
  return raw ? raw.trim() : null;
}

function resolveRunIdFromMessage(message: ChatMessage): string | null {
  const metadata =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : null;
  const runId = firstNonEmptyString([
    metadata?.["runId"],
    metadata?.["run_id"],
  ]);
  return runId ? runId.trim() : null;
}

function resolveMessageType(message: ChatMessage): string | null {
  const direct = normalizeMessageTypeValue(message.messageType);
  if (direct) {
    return direct;
  }
  const metadata =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : null;
  return (
    normalizeMessageTypeValue(metadata?.["messageType"]) ??
    normalizeMessageTypeValue(metadata?.["message_type"])
  );
}

function isGoalUpdateMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && resolveMessageType(message) === "goal_update";
}

function isNormalAssistantAnswer(message: ChatMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const messageType = resolveMessageType(message);
  return !messageType || !TIMELINE_MESSAGE_TYPES.has(messageType);
}

function compareMessageDisplayOrder(a: ChatMessage, b: ChatMessage): number {
  const aRunId = resolveRunIdFromMessage(a);
  const bRunId = resolveRunIdFromMessage(b);
  if (aRunId && aRunId === bRunId) {
    const aIsGoalUpdate = isGoalUpdateMessage(a);
    const bIsGoalUpdate = isGoalUpdateMessage(b);
    if (aIsGoalUpdate !== bIsGoalUpdate) {
      if (aIsGoalUpdate && isNormalAssistantAnswer(b)) {
        return 1;
      }
      if (bIsGoalUpdate && isNormalAssistantAnswer(a)) {
        return -1;
      }
    }
  }
  return a.timestamp - b.timestamp;
}

function stripBrowserSessionDispatchPrelude(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }
  const sections = trimmed.split(/\n\s*\n/);
  if (sections.length < 2) {
    return null;
  }
  const instructionBlock = sections[0]?.trim() ?? "";
  const body = sections.slice(1).join("\n\n").trim();
  if (!instructionBlock || !body) {
    return null;
  }
  const lines = instructionBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const looksLikeTargetedPrelude =
    lines.length >= 3 &&
    lines[0]?.startsWith('Use the existing "') &&
    lines[1]?.startsWith("That page is ") &&
    lines[2]?.startsWith("Keep any other open browser pages available");
  const looksLikeNewPagePrelude =
    lines.length >= 2 &&
    lines[0] === "Open this request in a fresh browser page/context while keeping any existing browser pages available." &&
    lines[1] === "Reuse the current browser-capable runtime when possible. Prefer another page in the shared browser session unless I explicitly ask for isolation or separate login state.";
  return looksLikeTargetedPrelude || looksLikeNewPagePrelude ? body : null;
}

function mapDetailKindToMessageType(value: unknown): string | null {
  const kind = normalizeMessageTypeValue(value);
  if (!kind) {
    return null;
  }
  switch (kind) {
    case "codex_command_execution":
      return "command_execution";
    case "codex_mcp_tool_call":
      return "mcp_tool_call";
    case "codex_web_search":
      return "web_search";
    default:
      return null;
  }
}

function firstNonEmptyString(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    if (candidate.trim().length === 0) {
      continue;
    }
    return candidate;
  }
  return null;
}

function resolveNestedDetailsRecord(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const details = isPlainObject(metadata["details"]) ? (metadata["details"] as Record<string, unknown>) : null;
  if (!details) {
    return null;
  }

  let resolved: Record<string, unknown> = details;
  // Runtime/controller updates can wrap detail payloads in runtime-selection envelopes.
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = isPlainObject(resolved["details"]) ? (resolved["details"] as Record<string, unknown>) : null;
    if (!nested) {
      break;
    }
    const hasWrapperShape =
      typeof resolved["runtimeId"] === "string" ||
      typeof resolved["displayName"] === "string" ||
      typeof resolved["messageType"] === "string" ||
      typeof resolved["message_type"] === "string" ||
      (typeof resolved["kind"] === "string" && resolved["kind"] === "runtime_selection");
    if (!hasWrapperShape) {
      break;
    }
    resolved = nested;
  }

  return resolved;
}

function resolveMessageTypeFromMetadata(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }
  const direct = normalizeMessageTypeValue(metadata["messageType"]);
  if (direct) {
    return direct;
  }
  const snake = normalizeMessageTypeValue(metadata["message_type"]);
  if (snake) {
    return snake;
  }

  const details = resolveNestedDetailsRecord(metadata);
  if (!details) {
    return null;
  }

  const nestedDirect = normalizeMessageTypeValue(details["messageType"]);
  if (nestedDirect) {
    return nestedDirect;
  }
  const nestedSnake = normalizeMessageTypeValue(details["message_type"]);
  if (nestedSnake) {
    return nestedSnake;
  }
  const nestedType = normalizeMessageTypeValue(details["type"]);
  if (nestedType && TIMELINE_MESSAGE_TYPES.has(nestedType)) {
    return nestedType;
  }
  return mapDetailKindToMessageType(details["kind"]);
}

function normalizeControllerMetadata(
  metadata: Record<string, unknown> | null,
  messageType: string | null
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  const normalized: Record<string, unknown> = { ...metadata };
  if (messageType) {
    normalized["messageType"] = messageType;
  }

  const details = isPlainObject(normalized["details"]) ? { ...(normalized["details"] as Record<string, unknown>) } : null;
  const detailsEvent = details && isPlainObject(details["event"]) ? (details["event"] as Record<string, unknown>) : null;

  if (details && messageType && !normalizeMessageTypeValue(details["messageType"]) && !normalizeMessageTypeValue(details["message_type"])) {
    details["messageType"] = messageType;
  }

  if (messageType === "command_execution" && details) {
    const aggregatedOutput = firstNonEmptyString([
      details["aggregatedOutput"],
      details["aggregated_output"],
      detailsEvent?.["aggregatedOutput"],
      detailsEvent?.["aggregated_output"],
      normalized["aggregatedOutput"],
      normalized["aggregated_output"],
    ]);
    if (aggregatedOutput) {
      details["aggregatedOutput"] = aggregatedOutput;
      if (!firstNonEmptyString([normalized["aggregatedOutput"], normalized["aggregated_output"]])) {
        normalized["aggregatedOutput"] = aggregatedOutput;
      }
    }

    const status = firstNonEmptyString([
      details["status"],
      detailsEvent?.["status"],
      normalized["status"],
    ]);
    if (status && !firstNonEmptyString([details["status"]])) {
      details["status"] = status;
    }

    const itemId = firstNonEmptyString([
      details["itemId"],
      details["item_id"],
      detailsEvent?.["itemId"],
      detailsEvent?.["item_id"],
    ]);
    if (itemId && !firstNonEmptyString([details["itemId"]])) {
      details["itemId"] = itemId;
    }
  }

  if (details) {
    normalized["details"] = details;
  }

  return normalized;
}

function mergeMessageMetadata(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!existing && !incoming) {
    return null;
  }

  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };

  for (const key of ["agent", "localCapability", "robotLearning", "cameraRequest"]) {
    const existingNested = isPlainObject(existing?.[key]) ? (existing?.[key] as Record<string, unknown>) : null;
    const incomingNested = isPlainObject(incoming?.[key]) ? (incoming?.[key] as Record<string, unknown>) : null;
    if (existingNested || incomingNested) {
      merged[key] = {
        ...(existingNested ?? {}),
        ...(incomingNested ?? {}),
      };
    }
  }

  return merged;
}

function isLocalCapabilityMetadata(value: Record<string, unknown> | null | undefined): boolean {
  if (!value) {
    return false;
  }
  if (isPlainObject(value["localCapability"])) {
    return true;
  }
  const kind = normalizeMessageTypeValue(value["kind"]);
  return kind === "local_capability_result";
}

function isFailedOrCanceledOutcome(message: ChatMessage): boolean {
  const outcome = isPlainObject(message.metadata)
    ? normalizeMessageTypeValue(message.metadata["outcome"])
    : null;
  return outcome === "failed" || outcome === "canceled" || outcome === "cancelled";
}

function mergeDuplicateMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const existingMetadata =
    existing.metadata && typeof existing.metadata === "object"
      ? (existing.metadata as Record<string, unknown>)
      : null;
  const incomingMetadata =
    incoming.metadata && typeof incoming.metadata === "object"
      ? (incoming.metadata as Record<string, unknown>)
      : null;
  const preserveAssistantRole =
    existing.role === "assistant" &&
    incoming.role !== "assistant" &&
    (isLocalCapabilityMetadata(existingMetadata) || isLocalCapabilityMetadata(incomingMetadata));
  return {
    ...incoming,
    role: preserveAssistantRole ? existing.role : incoming.role,
    files: incoming.files ?? existing.files,
    // The commit range stays paired with whichever files list won: pinning one
    // run's files to another run's base..head would fetch wrong diffs.
    commitRange: (incoming.files ? incoming.commitRange : existing.commitRange) ?? null,
    // So does the save outcome: it describes the run that produced those files.
    unsavedReason: (incoming.files ? incoming.unsavedReason : existing.unsavedReason) ?? null,
    messageType: incoming.messageType ?? existing.messageType,
    metadata: mergeMessageMetadata(
      existingMetadata,
      incomingMetadata,
    ),
  };
}

export function isUuid(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return UUID_REGEX.test(value);
}

export function isTimelineMessage(message: ChatMessage): boolean {
  const direct = normalizeMessageTypeValue(message.messageType);
  if (direct && TIMELINE_MESSAGE_TYPES.has(direct)) {
    return true;
  }
  const metadata = message.metadata;
  if (metadata && typeof metadata === "object") {
    const camel = normalizeMessageTypeValue((metadata as Record<string, unknown>)["messageType"]);
    if (camel && TIMELINE_MESSAGE_TYPES.has(camel)) {
      return true;
    }
    const snake = normalizeMessageTypeValue((metadata as Record<string, unknown>)["message_type"]);
    if (snake && TIMELINE_MESSAGE_TYPES.has(snake)) {
      return true;
    }
  }
  return false;
}

function parseChangeType(value: unknown): ChatMessageFileChangeType {
  if (typeof value !== "string") {
    return "unknown";
  }
  switch (value.trim().toLowerCase()) {
    case "created":
      return "created";
    case "deleted":
      return "deleted";
    case "changed":
      return "changed";
    default:
      return "unknown";
  }
}

function parseLineRangeValue(value: unknown): ChatMessageFileLineRange | null {
  if (isPlainObject(value)) {
    const from = typeof value.from === "number" && Number.isFinite(value.from) ? Math.floor(value.from) : null;
    const to = typeof value.to === "number" && Number.isFinite(value.to) ? Math.floor(value.to) : null;
    if (from !== null && to !== null) {
      return { from, to };
    }
  }
  if (Array.isArray(value) && value.length >= 2) {
    const [rawFrom, rawTo] = value;
    if (typeof rawFrom === "number" && Number.isFinite(rawFrom) && typeof rawTo === "number" && Number.isFinite(rawTo)) {
      return { from: Math.floor(rawFrom), to: Math.floor(rawTo) };
    }
  }
  return null;
}

function parseLineRangesValue(value: unknown): ChatMessageFileLineRange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => parseLineRangeValue(entry))
    .filter((entry): entry is ChatMessageFileLineRange => entry !== null);
}

function interpretRawChange(
  value: unknown
): { changeType: ChatMessageFileChangeType; lineRanges: ChatMessageFileLineRange[] } | null {
  if (!value) {
    return null;
  }
  if (isPlainObject(value)) {
    const changeType = parseChangeType(value.type);
    const lineRanges = parseLineRangesValue(value.lines);
    return { changeType, lineRanges };
  }
  if (typeof value === "string") {
    const changeType = parseChangeType(value);
    return { changeType, lineRanges: [] };
  }
  return null;
}

function parseFileChange(value: unknown): ChatMessageFileChange | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const pathInput = value["path"];
  const pathRaw = typeof pathInput === "string" ? pathInput.trim() : "";
  if (!pathRaw) {
    return null;
  }
  const workspacePathInput = value["workspacePath"];
  const workspacePath =
    typeof workspacePathInput === "string" && workspacePathInput.trim().length > 0
      ? workspacePathInput.trim()
      : pathRaw;
  const labelInput = value["label"];
  const label =
    typeof labelInput === "string" && labelInput.trim().length > 0
      ? labelInput.trim()
      : pathRaw.split("/").pop() ?? pathRaw;
  const descriptionInput = value["description"];
  const description =
    typeof descriptionInput === "string" && descriptionInput.trim().length > 0
      ? descriptionInput.trim()
      : undefined;
  const mimeTypeInput = value["mimeType"];
  const mimeType =
    typeof mimeTypeInput === "string" && mimeTypeInput.trim().length > 0 ? mimeTypeInput.trim() : undefined;

  const rawChange = Object.prototype.hasOwnProperty.call(value, "change") ? value["change"] : null;
  const changeFromRaw = interpretRawChange(rawChange);
  let changeType = changeFromRaw?.changeType ?? "unknown";
  let lineRanges = changeFromRaw?.lineRanges ?? [];

  const changeTypeFallback = value["changeType"];
  if (changeType === "unknown") {
    changeType = parseChangeType(changeTypeFallback);
  }
  const changeLinesFallback = value["changeLines"];
  if (lineRanges.length === 0) {
    lineRanges = parseLineRangesValue(changeLinesFallback);
  }

  return {
    path: pathRaw,
    workspacePath,
    label,
    description,
    mimeType,
    changeType,
    lineRanges,
    rawChange,
  };
}

export function extractFileChangesFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ChatMessageFileChange[] {
  if (!metadata) {
    return [];
  }
  const artifacts = metadata["artifacts"];
  if (!Array.isArray(artifacts)) {
    return [];
  }
  const filesArtifact = artifacts.find(
    (artifact): artifact is Record<string, unknown> =>
      isPlainObject(artifact) && typeof artifact.kind === "string" && artifact.kind === "apply/files"
  );
  if (!filesArtifact) {
    return [];
  }
  const filesValue = filesArtifact["files"];
  if (!Array.isArray(filesValue)) {
    return [];
  }
  return filesValue
    .map((entry) => parseFileChange(entry))
    .filter((entry): entry is ChatMessageFileChange => entry !== null);
}

// The paths a checkpoint's save selected, as the runtime recorded them.
function readSavedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      paths.add(entry.trim());
    }
  }
  return Array.from(paths);
}

function gitRevString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  // Apply revs can be timestamps on non-git flows; only real commit ids are
  // addressable in the origin workspace repo.
  return /^[0-9a-f]{7,64}$/i.test(trimmed) ? trimmed : null;
}

// The base..head commit pair of the run that produced this message's file
// changes, taken from the runtime's origin/apply artifact. Lets the diff cards
// show what *that run* changed (as a real edit diff even on snapshot-history
// origins, and stable after later edits). `source` says which pair it is:
// only the canonical "git" pair names commits on the space's saved history,
// so only that one can be reverted as a saved version.
export function extractWorkspaceCommitRangeFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ChatMessageCommitRange | null {
  if (!metadata) {
    return null;
  }
  const artifacts = metadata["artifacts"];
  if (!Array.isArray(artifacts)) {
    return null;
  }
  // Prefer the newest apply artifact: retried runs append a fresh one.
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!isPlainObject(artifact) || artifact.kind !== "origin/apply") {
      continue;
    }
    const artifactMetadata = isPlainObject(artifact["metadata"]) ? artifact["metadata"] : null;
    if (!artifactMetadata) {
      continue;
    }
    // A command lane's own save, such as the skill files `/skills import --start`
    // saves before the turn, is not the range of this message's file changes.
    if (typeof artifactMetadata["lane"] === "string") {
      continue;
    }
    const gitPair = {
      base: gitRevString(artifactMetadata["gitBaseRev"]),
      head: gitRevString(artifactMetadata["gitRev"]),
    };
    const applyPair = {
      base: gitRevString(artifactMetadata["baseRev"]),
      head: gitRevString(artifactMetadata["rev"]),
    };
    // Never mix pairs: base and head must bracket the same commit operation.
    const source = gitPair.base && gitPair.head ? "git" : "apply";
    const pair = source === "git" ? gitPair : applyPair;
    if (pair.base && pair.head && pair.base !== pair.head) {
      const savedPaths = source === "git" ? readSavedPaths(artifactMetadata["paths"]) : [];
      return savedPaths.length > 0
        ? { base: pair.base, head: pair.head, source, savedPaths }
        : { base: pair.base, head: pair.head, source };
    }
  }
  return null;
}

// The newest origin/apply artifact of the turn's own save. A command lane's
// save (such as the skill files `/skills import --start` saves first) is not
// the save of this message's file changes.
function findTurnOriginApplyMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  const artifacts = metadata?.["artifacts"];
  if (!Array.isArray(artifacts)) {
    return null;
  }
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!isPlainObject(artifact) || artifact.kind !== "origin/apply") {
      continue;
    }
    const artifactMetadata = isPlainObject(artifact["metadata"]) ? artifact["metadata"] : null;
    if (!artifactMetadata || typeof artifactMetadata["lane"] === "string") {
      continue;
    }
    return artifactMetadata;
  }
  return null;
}

const NOT_SAVED_REJECTION_REASONS: ReadonlySet<ChatMessageNotSavedReason> = new Set([
  "excluded",
  "secret",
  "ignored",
  "too_large",
  "attachment",
  "policy",
  "unsupported",
]);

function normalizeUnsavedPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

function parseNotSavedReason(value: unknown): ChatMessageNotSavedReason {
  const normalized = normalizeMessageTypeValue(value)?.replace(/-/g, "_") ?? null;
  return normalized && NOT_SAVED_REJECTION_REASONS.has(normalized as ChatMessageNotSavedReason)
    ? (normalized as ChatMessageNotSavedReason)
    : "unknown";
}

export interface ChatMessageUnsavedPath extends ChatMessageFileNotSaved {
  path: string;
}

// The files the turn's save left out of the space's saved history, one entry
// per path, from the artifact's `conflictedPaths` (the space changed them too;
// the agent's version is kept as unsaved work) and `rejectedPaths` (refused
// by the space's file rules, each with a `reason`). The runtime has written
// both since saves publish by merging. A conflicted path wins over a rejected
// one for the same file.
export function extractUnsavedPathsFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ChatMessageUnsavedPath[] {
  const artifactMetadata = findTurnOriginApplyMetadata(metadata);
  if (!artifactMetadata) {
    return [];
  }
  const byPath = new Map<string, ChatMessageUnsavedPath>();
  const conflicted = artifactMetadata["conflictedPaths"];
  if (Array.isArray(conflicted)) {
    for (const entry of conflicted) {
      const path = normalizeUnsavedPath(isPlainObject(entry) ? entry["path"] : entry);
      if (path && !byPath.has(path)) {
        byPath.set(path, { path, reason: "conflicted", keptSavedVersion: true });
      }
    }
  }
  const rejected = artifactMetadata["rejectedPaths"];
  if (Array.isArray(rejected)) {
    for (const entry of rejected) {
      const record = isPlainObject(entry) ? entry : null;
      const path = normalizeUnsavedPath(record ? record["path"] : entry);
      if (!path || byPath.has(path)) {
        continue;
      }
      byPath.set(path, {
        path,
        reason: parseNotSavedReason(record?.["reason"]),
        keptSavedVersion: record?.["keptSavedVersion"] === true || record?.["kept_saved_version"] === true,
      });
    }
  }
  return Array.from(byPath.values());
}

// Marks each file change whose path the turn's save left out. Paths the save
// reported that are not among the message's files are left to the agent's own
// "Not saved: ..." sentence at the end of its reply.
export function attachUnsavedPathsToFileChanges(
  files: ChatMessageFileChange[],
  unsavedPaths: ChatMessageUnsavedPath[]
): ChatMessageFileChange[] {
  if (files.length === 0 || unsavedPaths.length === 0) {
    return files;
  }
  const byPath = new Map(unsavedPaths.map((entry) => [entry.path, entry] as const));
  return files.map((file) => {
    const path = normalizeUnsavedPath(file.workspacePath) ?? normalizeUnsavedPath(file.path);
    const entry = path ? byPath.get(path) : undefined;
    return entry ? { ...file, notSaved: { reason: entry.reason, keptSavedVersion: entry.keptSavedVersion } } : file;
  });
}

const HISTORY_EXCLUSION_MARKER = "path is excluded from space history:";

// The paths the origin refused to save, from a "skipped" save's gitSyncError.
// The runtime stores the origin's 400 as `origin git sync failed (...):
// {"error":"path is excluded from space history: tmp/a.txt, node_modules/x"}`,
// so the list is the ", "-joined text after the marker.
function parseHistoryExcludedPaths(error: unknown): string | null {
  if (typeof error !== "string") {
    return null;
  }
  let message = error;
  const bodyStart = error.indexOf("{");
  if (bodyStart >= 0) {
    try {
      const body: unknown = JSON.parse(error.slice(bodyStart));
      if (isPlainObject(body) && typeof body["error"] === "string") {
        message = body["error"];
      }
    } catch {
      // Not a JSON body: read the marker from the raw text.
    }
  }
  const markerIndex = message.toLowerCase().indexOf(HISTORY_EXCLUSION_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  const detail = message.slice(markerIndex + HISTORY_EXCLUSION_MARKER.length).trim();
  return detail || null;
}

// The origin rejects the whole /git/sync request when any path in it is
// excluded from history (tmp/, node_modules, .pnpm-store), so nothing in the
// request is committed, yet the runtime still labels that "skipped". It is
// only harmless when every path the run tried to save was an excluded one.
function skippedSaveLeftPathsUnsaved(artifactMetadata: Record<string, unknown>): boolean {
  const excluded = parseHistoryExcludedPaths(artifactMetadata["gitSyncError"]);
  if (!excluded) {
    return false;
  }
  // "paths" is exactly what the runtime sent to /git/sync.
  const requested = Array.isArray(artifactMetadata["paths"]) ? artifactMetadata["paths"] : [];
  // Delimit both sides so "notes.md" never matches inside "tmp/notes.md".
  const excludedList = `, ${excluded}, `;
  return requested.some((path) => {
    if (typeof path !== "string") {
      return false;
    }
    const normalized = path.trim().replace(/^\/+|\/+$/g, "");
    return normalized.length > 0 && !excludedList.includes(`, ${normalized}, `);
  });
}

// Whether the run that produced this message's file changes failed to save
// them, from the runtime's origin/apply artifact. The runtime records
// gitSyncStatus "failed" when the save ran and errored, and "disabled" when
// saving was off so no save ran (its status message reports these as
// sync_failed and manual_required). "skipped" means the origin refused paths
// that are kept out of history; that is only a failed save when the same
// request also carried other paths, since the refusal saves none of them.
// "synced" is saved and "partial" saved all but some files, which are marked
// one by one (extractUnsavedPathsFromMetadata). No artifact means no save was
// attempted, and Desktop folders keep the files on the user's disk, so those
// return null.
export function extractUnsavedReasonFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ChatMessageUnsavedReason | null {
  if (!metadata) {
    return null;
  }
  const artifacts = metadata["artifacts"];
  if (!Array.isArray(artifacts)) {
    return null;
  }
  // The newest apply artifact wins, like the commit range: retried runs append
  // a fresh one.
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!isPlainObject(artifact) || artifact.kind !== "origin/apply") {
      continue;
    }
    const artifactMetadata = isPlainObject(artifact["metadata"]) ? artifact["metadata"] : null;
    const gitSyncStatus = normalizeMessageTypeValue(artifactMetadata?.["gitSyncStatus"]);
    if (!gitSyncStatus) {
      continue;
    }
    // A Desktop origin writes into the user's own folder, so the files are on
    // their disk either way; only machine-hosted copies can be lost.
    if (normalizeMessageTypeValue(artifactMetadata?.["mode"]) === "desktop") {
      return null;
    }
    if (gitSyncStatus === "failed") {
      return "save_failed";
    }
    if (gitSyncStatus === "disabled") {
      return "auto_save_off";
    }
    if (gitSyncStatus === "skipped" && artifactMetadata && skippedSaveLeftPathsUnsaved(artifactMetadata)) {
      return "save_failed";
    }
    return null;
  }
  return null;
}

function serializeFileChanges(files: ChatMessage["files"]): string {
  if (!files || files.length === 0) {
    return "[]";
  }
  const simplified = files.map((file) => ({
    path: file.path,
    changeType: file.changeType,
    lineRanges: file.lineRanges.map((range) => [range.from, range.to]),
  }));
  try {
    return JSON.stringify(simplified);
  } catch (_error) {
    return "[]";
  }
}

export function mapControllerMessageToChat(message: ControllerConversationMessage): ChatMessage {
  const timestamp = Date.parse(message.createdAt);
  const rawMetadata = isPlainObject(message.metadata) ? (message.metadata as Record<string, unknown>) : null;
  const messageTypeRaw = resolveMessageTypeFromMetadata(rawMetadata);
  let metadata = normalizeControllerMetadata(rawMetadata, messageTypeRaw);
  const runId = typeof message.runId === "string" ? message.runId.trim() : "";
  if (runId) {
    if (metadata && typeof metadata === "object") {
      const map = metadata as Record<string, unknown>;
      const existingRunId = typeof map["runId"] === "string" ? map["runId"].trim() : "";
      const existingSnakeRunId = typeof map["run_id"] === "string" ? map["run_id"].trim() : "";
      if (!existingRunId && !existingSnakeRunId) {
        metadata = {
          ...map,
          runId,
        };
      }
    } else {
      metadata = { runId };
    }
  }
  const files = attachUnsavedPathsToFileChanges(
    extractFileChangesFromMetadata(metadata),
    extractUnsavedPathsFromMetadata(metadata),
  );
  const commitRange = extractWorkspaceCommitRangeFromMetadata(metadata);
  const unsavedReason = extractUnsavedReasonFromMetadata(metadata);
  const promptMetadata = resolvePromptMetadataRecord(metadata);
  const displayContent =
    message.role === "user"
      ? firstNonEmptyString([
          promptMetadata?.["displayContent"],
          promptMetadata?.["display_content"],
          promptMetadata?.["composerMessage"],
          promptMetadata?.["composer_message"],
        ]) ?? stripBrowserSessionDispatchPrelude(message.content) ?? message.content
      : message.content;
  return {
    id: message.id,
    role: message.role,
    authorId: message.createdBy ?? null,
    content: displayContent,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    files: files.length > 0 ? files : null,
    commitRange,
    unsavedReason,
    messageType: messageTypeRaw,
    metadata,
  };
}

type MessageMergeKeys = { id: string; clientId: string | null; content: string };
type MessageMergeEntry = { message: ChatMessage; keys: MessageMergeKeys };

function messageMergeKeys(message: ChatMessage): MessageMergeKeys {
  const clientId = resolveClientMessageIdFromMetadata(message.metadata ?? null);
  return {
    id: message.id,
    clientId: clientId ? JSON.stringify([message.role, clientId]) : null,
    content: JSON.stringify([message.role, message.content.trim(), serializeFileChanges(message.files)]),
  };
}

// Most keys identify one message. Content keys can intentionally identify many
// separate turns; retain their first position to preserve the existing merge
// precedence. Only replacing/removing that first match scans its collision set.
class MessageMergeIndex {
  private readonly positions = new Map<string, { first: number; all: Set<number> }>();

  add(key: string | null, position: number) {
    if (key === null) return;
    const bucket = this.positions.get(key);
    if (!bucket) {
      this.positions.set(key, { first: position, all: new Set([position]) });
      return;
    }
    bucket.all.add(position);
    bucket.first = Math.min(bucket.first, position);
  }

  remove(key: string | null, position: number) {
    if (key === null) return;
    const bucket = this.positions.get(key);
    if (!bucket) return;
    bucket.all.delete(position);
    if (bucket.all.size === 0) {
      this.positions.delete(key);
    } else if (bucket.first === position) {
      bucket.first = Infinity;
      for (const candidate of bucket.all) bucket.first = Math.min(bucket.first, candidate);
    }
  }

  first(key: string | null): number | undefined {
    return key === null ? undefined : this.positions.get(key)?.first;
  }
}

export function mergeAndSortMessages(messages: ChatMessage[]): ChatMessage[] {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const entries: Array<MessageMergeEntry | null> = [];
  const indexes = {
    id: new MessageMergeIndex(),
    clientId: new MessageMergeIndex(),
    content: new MessageMergeIndex(),
  };
  const store = (message: ChatMessage, position = entries.length, keys = messageMergeKeys(message)) => {
    const previousKeys = entries[position]?.keys;
    entries[position] = { message, keys };
    for (const key of ["id", "clientId", "content"] as const) {
      if (previousKeys?.[key] !== keys[key]) {
        if (previousKeys) indexes[key].remove(previousKeys[key], position);
        indexes[key].add(keys[key], position);
      }
    }
  };

  sorted.forEach((message) => {
    const keys = messageMergeKeys(message);
    const existingIndexById = indexes.id.first(keys.id);
    if (existingIndexById !== undefined) {
      store(mergeDuplicateMessage(entries[existingIndexById]!.message, message), existingIndexById);
      return;
    }

    const existingIndexByClientMessageId = indexes.clientId.first(keys.clientId);
    if (existingIndexByClientMessageId !== undefined) {
      store(
        mergeDuplicateMessage(entries[existingIndexByClientMessageId]!.message, message),
        existingIndexByClientMessageId,
      );
      return;
    }

    const sameContentIndex = indexes.content.first(keys.content);
    if (sameContentIndex !== undefined) {
      const existing = entries[sameContentIndex]!.message;
      if (isTimelineMessage(existing) || isTimelineMessage(message)) {
        store(message, entries.length, keys);
        return;
      }
      const incomingIsServer = isUuid(message.id);
      const existingIsServer = isUuid(existing.id);

      if (existingIsServer && incomingIsServer) {
        const existingJobId =
          existing.metadata && typeof existing.metadata.jobId === "string"
            ? existing.metadata.jobId
            : null;
        const incomingJobId =
          message.metadata && typeof message.metadata.jobId === "string"
            ? message.metadata.jobId
            : null;
        if (existingJobId && incomingJobId && existingJobId === incomingJobId) {
          // The controller can emit multiple assistant messages with identical content for the same
          // jobId (ex: a noisy lifecycle/status update plus a final assistant turn). The chat UI
          // intentionally hides many status-ish messages; if we always keep the first duplicate we
          // can accidentally drop the real assistant answer and render nothing. Prefer the
          // "less noisy"/more terminal variant when deduping by jobId+content.
          const resolveType = (candidate: ChatMessage): string | null => {
            const direct = normalizeMessageTypeValue(candidate.messageType);
            if (direct) {
              return direct;
            }
            const metadata = candidate.metadata;
            if (metadata && typeof metadata === "object") {
              const camel = normalizeMessageTypeValue((metadata as Record<string, unknown>)["messageType"]);
              if (camel) {
                return camel;
              }
              const snake = normalizeMessageTypeValue((metadata as Record<string, unknown>)["message_type"]);
              if (snake) {
                return snake;
              }
            }
            return null;
          };

          const resolveOutcomeRank = (candidate: ChatMessage): number => {
            const metadata = candidate.metadata && typeof candidate.metadata === "object"
              ? (candidate.metadata as Record<string, unknown>)
              : null;
            const raw = metadata && typeof metadata["outcome"] === "string" ? metadata["outcome"].trim().toLowerCase() : "";
            if (!raw) {
              return 1;
            }
            if (["succeeded", "success", "failed", "canceled", "cancelled", "merged", "completed"].includes(raw)) {
              return 3;
            }
            if (["in_progress", "running", "queued", "started", "pending"].includes(raw)) {
              return 0;
            }
            return 1;
          };

          const noisyTypes = new Set(["status", "reasoning", "token_usage"]);
          const existingType = resolveType(existing);
          const incomingType = resolveType(message);
          const existingNoisy = existingType ? noisyTypes.has(existingType) : false;
          const incomingNoisy = incomingType ? noisyTypes.has(incomingType) : false;

          let preferIncoming = false;
          let incomingFailureSupersedesProgress = false;
          if (existingNoisy !== incomingNoisy) {
            preferIncoming = !incomingNoisy;
          } else {
            const existingOutcomeRank = resolveOutcomeRank(existing);
            const incomingOutcomeRank = resolveOutcomeRank(message);
            if (incomingOutcomeRank !== existingOutcomeRank) {
              preferIncoming = incomingOutcomeRank > existingOutcomeRank;
              // A failed run is reported twice with the same text: once as a streamed
              // progress update and once as the job failure. Only the failure closes
              // the run, so it must not inherit the update's markers below.
              incomingFailureSupersedesProgress =
                existingOutcomeRank === 0 && isFailedOrCanceledOutcome(message);
            } else {
              // Last write wins for identical-ish duplicates.
              preferIncoming = message.timestamp >= existing.timestamp;
            }
          }

          if (preferIncoming) {
            const removedKeys = entries[sameContentIndex]!.keys;
            for (const key of ["id", "clientId", "content"] as const) {
              indexes[key].remove(removedKeys[key], sameContentIndex);
            }
            entries[sameContentIndex] = null;
            const merged = mergeDuplicateMessage(existing, message);
            if ((existingNoisy && !incomingNoisy) || incomingFailureSupersedesProgress) {
              // The selected answer owns its presentation, including absent fields.
              // Rehydrating the losing status/hidden markers can hide the final reply,
              // and a leftover `kind: "update"` keeps a failed run looking unfinished.
              merged.messageType = message.messageType ?? null;
              if (merged.metadata) {
                for (const key of ["messageType", "message_type", "kind", "details", "presentation"]) {
                  delete merged.metadata[key];
                  if (message.metadata && Object.prototype.hasOwnProperty.call(message.metadata, key)) {
                    merged.metadata[key] = message.metadata[key];
                  }
                }
              }
            }
            store(merged);
          }
          return;
        }
        store(message, entries.length, keys);
        return;
      }

      if (existingIsServer !== incomingIsServer) {
        const localPlaceholder = existingIsServer ? message : existing;
        const serverCopy = existingIsServer ? existing : message;
        store(mergeDuplicateMessage(localPlaceholder, serverCopy), sameContentIndex);
        return;
      }

      store(message, entries.length, keys);
      return;
    }

    store(message, entries.length, keys);
  });

  return entries.flatMap((entry) => entry ? [entry.message] : []).sort(compareMessageDisplayOrder);
}
