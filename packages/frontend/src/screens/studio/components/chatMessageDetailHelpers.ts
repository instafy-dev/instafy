import { toUserPromptSuggestion } from "../../../conversations/suggestedReplyVoice";
import { findConnectorForSecret, type ProductConnector } from "./connectors";
import {
  isValidSecretName,
  normalizeRefusedSecretClass,
  refusedSecretClass,
  sanitizeCardText,
  sanitizeSkillSlug,
} from "./packCardText";
import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import { parseCommandExecutionOutput } from "./chatContentHelpers";
import { extractAgentJobId } from "./chatMessagePresentation";

const MAX_UI_SUGGESTED_REPLIES = 3;
const MAX_UI_SUGGESTED_REPLY_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCurrentUserChatMessage(
  message: ChatMessage,
  currentUserId: string | null | undefined,
  chatClientSessionId: string | null | undefined,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const normalizedCurrentUserId = typeof currentUserId === "string" ? currentUserId.trim() : "";
  const normalizedChatClientSessionId =
    typeof chatClientSessionId === "string" ? chatClientSessionId.trim() : "";
  const authorId = typeof message.authorId === "string" ? message.authorId.trim() : "";
  const clientIdentity = extractChatClientIdentity(message.metadata);
  const clientUserId = clientIdentity?.userId ?? "";
  const clientSessionId = clientIdentity?.sessionId ?? "";
  return (
    (normalizedCurrentUserId.length > 0 && authorId === normalizedCurrentUserId) ||
    (normalizedCurrentUserId.length > 0 && clientUserId === normalizedCurrentUserId) ||
    (normalizedChatClientSessionId.length > 0 && clientSessionId === normalizedChatClientSessionId)
  );
}

function formatStatusLabel(status: string): string {
  const pretty = status.replace(/[_-]+/g, " ").trim();
  if (!pretty) {
    return "";
  }
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function resolveStatusBadge(status: string | null): { label: string; className: string } | null {
  if (!status) {
    return null;
  }
  const normalized = status.trim().toLowerCase();
  const base = "border-slate-200 bg-slate-100 text-slate-600";
  switch (normalized) {
    case "completed":
      return { label: "Completed", className: "border-primary-200 bg-primary-50 text-primary-700" };
    case "failed":
      return { label: "Failed", className: "border-rose-200 bg-rose-50 text-rose-700" };
    case "in_progress":
      return { label: "In progress", className: "border-primary-200 bg-primary-50 text-primary-600" };
    default:
      return { label: formatStatusLabel(status), className: base };
  }
}

function getNumberValue(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function parseIntegrationSecretDescriptors(
  record: Record<string, unknown>,
  keys: string[],
): { name: string; description: string | null }[] {
  const out: { name: string; description: string | null }[] = [];
  const seen = new Set<string>();

  const push = (nameCandidate: unknown, descriptionCandidate: unknown) => {
    if (typeof nameCandidate !== "string") {
      return;
    }
    const name = nameCandidate.trim();
    if (!name) {
      return;
    }
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);

    const description =
      typeof descriptionCandidate === "string" && descriptionCandidate.trim().length > 0
        ? descriptionCandidate.trim()
        : null;

    out.push({ name, description });
  };

  for (const key of keys) {
    const value = record[key];
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          push(entry, null);
          continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          continue;
        }
        const map = entry as Record<string, unknown>;
        const nameCandidate =
          (typeof map["name"] === "string" && map["name"]) ||
          (typeof map["secretName"] === "string" && map["secretName"]) ||
          (typeof map["secret_name"] === "string" && map["secret_name"]) ||
          (typeof map["envVar"] === "string" && map["envVar"]) ||
          (typeof map["env_var"] === "string" && map["env_var"]) ||
          "";
        push(nameCandidate, map["description"]);
      }
      continue;
    }
    if (typeof value === "string") {
      push(value, null);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      const nameCandidate =
        (typeof map["name"] === "string" && map["name"]) ||
        (typeof map["secretName"] === "string" && map["secretName"]) ||
        (typeof map["secret_name"] === "string" && map["secret_name"]) ||
        (typeof map["envVar"] === "string" && map["envVar"]) ||
        (typeof map["env_var"] === "string" && map["env_var"]) ||
        "";
      push(nameCandidate, map["description"]);
    }
  }

  return out;
}

function parseIntegrationStringList(
  record: Record<string, unknown>,
  keys: string[],
  lowercase: boolean,
  stripAtPrefix: boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const value = record[key];
    if (!value) {
      continue;
    }

    const entries: string[] = [];
    if (typeof value === "string") {
      entries.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          entries.push(entry);
        }
      }
    }

    for (const entry of entries) {
      let normalized = entry.trim();
      if (stripAtPrefix) {
        normalized = normalized.replace(/^@/, "").trim();
      }
      if (!normalized) {
        continue;
      }
      if (lowercase) {
        normalized = normalized.toLowerCase();
      }
      const dedupeKey = normalized.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      out.push(normalized);
    }
  }

  return out;
}

export type PromptContextUsage = {
  mode: string | null;
  estimatedPromptTokens: number | null;
  estimatedPromptUsagePercent: number | null;
  estimatedHistoryTokens: number | null;
  modelContextWindow: number | null;
  totalTurns: number | null;
  includedTurns: number | null;
  summarizedTurns: number | null;
  omittedTurns: number | null;
};

export type TokenUsageSummary = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  context: PromptContextUsage | null;
};

/**
 * One secret request, with every pack-authored string already through the
 * sanitizer. The runtime cleans these before it persists them; this runs the
 * same rules again because a message written by an older runtime outlives any
 * deploy, and the card is the last line before a DOM node.
 */
export type ParsedSecretRequestDetails = {
  /** The destination. Validated, never cleaned; null when we cannot read it. */
  name: string | null;
  /** The pack's own word for the value, the second half of the card title. */
  valueLabel: string | null;
  /** One sentence saying what the value lets Instafy do for the person. */
  description: string | null;
  /** One sentence naming the screen inside the provider it is found on. */
  whereToGet: string | null;
  /**
   * True when the request said something about where the value lives and the
   * gate above refused it. It separates "nobody told us" from "we were told
   * and would not repeat it", which the card answers differently: silence is a
   * dead end worth filling, a refusal is not an invitation to go asking.
   */
  whereToGetRefused: boolean;
  /** The folder under .agents/skills that declared the need. Provenance only. */
  skill: string | null;
  /** Whether the input masks by default. Absent or unreadable means true. */
  sensitive: boolean;
  /**
   * Set when the runtime refused the request because it asked for a human
   * login credential. Named from our own fixed table, never from the pack.
   */
  refusedClass: string | null;
  /**
   * The catalogue entry this request resolves to, by variable name and, when
   * the request declares one, by skill slug as well. Identity only: the name
   * and the mark the card wears, and the one product name the pack's own text
   * is allowed to contain.
   */
  connector: ProductConnector | null;
  agentHandles: string[];
};

export type ParsedIntegrationRequestDetails = {
  provider: string | null;
  description: string | null;
  requiredScopes: string[];
  capabilities: string[];
  authMethods: string[];
  suggestedSecretNames: string[];
  suggestedSecrets: { name: string; description: string | null }[];
  agentHandles: string[];
};

export type ChatClientIdentity = {
  userId: string | null;
  sessionId: string | null;
};

export type TemplateOptionInfo = {
  id: string;
  label: string;
  description: string | null;
  tags: string[];
  creditCost: number | null;
  source: string | null;
};

export type TemplateToolCallInfo = {
  selection: TemplateOptionInfo | null;
  alternatives: TemplateOptionInfo[];
  total: number;
};

function readDetailString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

export function parseSecretRequestDetails(
  details: Record<string, unknown> | null | undefined,
): ParsedSecretRequestDetails {
  const record: Record<string, unknown> = details ?? {};
  const nameCandidate = readDetailString(record, [
    "name",
    "secretName",
    "secret_name",
    "envVar",
    "env_var",
  ]);
  // The destination is validated and never repaired: a name that needs
  // cleaning is a name we do not understand, and the card drops to its
  // no-name state rather than writing somewhere it guessed at.
  const validName = isValidSecretName(nameCandidate) ? nameCandidate : "";

  // The runtime refuses a human login credential before it writes the message,
  // and this gate derives the same refusal from the same table: a message a
  // runtime older than that rule persisted lives forever, and without this the
  // card would render a live input asking for the password.
  const refusedClass =
    normalizeRefusedSecretClass(
      record["refusedClass"] ?? record["refused_class"] ?? record["refused"],
    ) ?? refusedSecretClass(nameCandidate);
  // A refused request has no destination: the card shows the refusal and no
  // input, and no other card in the run counts this one as outstanding.
  const name = refusedClass ? "" : validName;

  const skill = sanitizeSkillSlug(readDetailString(record, ["skill", "skillName", "skill_name"]));
  // Identity, and the one product name the pack's own words may contain.
  const connector = findConnectorForSecret(name, skill);
  const owner = connector?.name ?? null;
  const valueLabel = sanitizeCardText(
    readDetailString(record, ["valueLabel", "value_label", "label"]),
    "valueLabel",
    owner,
    skill,
  );
  const description = sanitizeCardText(
    readDetailString(record, ["description"]),
    "description",
    owner,
    skill,
  );
  const whereToGetRaw = readDetailString(record, ["whereToGet", "where_to_get"]);
  const whereToGet = sanitizeCardText(whereToGetRaw, "whereToGet", owner, skill);
  const whereToGetRefused = Boolean(whereToGetRaw && whereToGetRaw.trim()) && whereToGet === null;
  // Absent or unreadable means sensitive: a value nobody labelled is one
  // worth hiding.
  const sensitive = record["sensitive"] === false ? false : true;

  const handlesRaw = Array.isArray(record["agentHandles"])
    ? record["agentHandles"]
    : Array.isArray(record["agent_handles"])
      ? record["agent_handles"]
      : null;
  const agentHandles =
    handlesRaw && Array.isArray(handlesRaw)
      ? handlesRaw
          .filter((value: unknown): value is string => typeof value === "string")
          .map((value) => value.trim().replace(/^@/, ""))
          .filter((value) => value.length > 0)
      : [];

  return {
    name: name.length > 0 ? name : null,
    valueLabel,
    description,
    whereToGet,
    whereToGetRefused,
    skill,
    sensitive,
    refusedClass,
    connector,
    agentHandles,
  };
}

export function parseIntegrationRequestDetails(
  details: Record<string, unknown> | null | undefined,
): ParsedIntegrationRequestDetails {
  const record: Record<string, unknown> = details ?? {};
  const providerCandidate =
    (typeof record["provider"] === "string" && record["provider"]) ||
    (typeof record["integration"] === "string" && record["integration"]) ||
    (typeof record["service"] === "string" && record["service"]) ||
    "";
  const provider = typeof providerCandidate === "string" ? providerCandidate.trim().toLowerCase() : "";

  const descriptionCandidate =
    (typeof record["description"] === "string" && record["description"]) ||
    (typeof record["reason"] === "string" && record["reason"]) ||
    "";
  const description = descriptionCandidate.trim().length > 0 ? descriptionCandidate.trim() : null;

  const requiredScopes = parseIntegrationStringList(
    record,
    ["requiredScopes", "required_scopes", "scopes"],
    true,
    false,
  );
  const capabilities = parseIntegrationStringList(
    record,
    ["capabilities", "requestedCapabilities", "requested_capabilities"],
    true,
    false,
  );
  const authMethods = parseIntegrationStringList(
    record,
    ["authMethods", "auth_methods"],
    true,
    false,
  );
  const suggestedSecretNamesFromPayload = parseIntegrationStringList(
    record,
    [
      "suggestedSecretNames",
      "suggested_secret_names",
      "secretNames",
      "secret_names",
      "defaultSecretNames",
      "default_secret_names",
    ],
    false,
    false,
  );
  const suggestedSecretsFromPayload = parseIntegrationSecretDescriptors(record, [
    "suggestedSecrets",
    "suggested_secrets",
  ]);
  const suggestedSecretNames = (() => {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const secret of suggestedSecretsFromPayload) {
      const key = secret.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(secret.name);
    }
    for (const name of suggestedSecretNamesFromPayload) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(name);
    }
    return merged;
  })();
  const suggestedSecrets = (() => {
    const byName = new Map<string, { name: string; description: string | null }>();
    for (const secret of suggestedSecretsFromPayload) {
      byName.set(secret.name.toLowerCase(), secret);
    }
    return suggestedSecretNames.map((name) => {
      const existing = byName.get(name.toLowerCase());
      return existing ?? { name, description: null };
    });
  })();
  const agentHandles = parseIntegrationStringList(
    record,
    ["agentHandles", "agent_handles"],
    true,
    true,
  );

  return {
    provider: provider.length > 0 ? provider : null,
    description,
    requiredScopes,
    capabilities,
    authMethods,
    suggestedSecretNames,
    suggestedSecrets,
    agentHandles,
  };
}

export function resolveUiSuggestedReplies(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata || !isRecord(metadata)) {
    return [];
  }

  const uiRecords: Record<string, unknown>[] = [];
  const seenUiRecords = new Set<Record<string, unknown>>();
  const collectUiRecord = (value: unknown) => {
    if (!isRecord(value) || seenUiRecords.has(value)) {
      return;
    }
    seenUiRecords.add(value);
    uiRecords.push(value);
  };

  collectUiRecord(metadata["ui"]);

  let detailsCursor: unknown = metadata["details"];
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(detailsCursor)) {
      break;
    }
    collectUiRecord(detailsCursor["ui"]);
    detailsCursor = detailsCursor["details"];
  }

  if (uiRecords.length === 0) {
    return [];
  }

  const candidates: unknown[] = [];
  for (const ui of uiRecords) {
    const list = ui["suggestedReplies"];
    if (Array.isArray(list)) {
      candidates.push(...list);
    } else if (typeof list === "string" || isRecord(list)) {
      candidates.push(list);
    }
    const direct = ui["suggestedReply"];
    if (typeof direct === "string" || isRecord(direct)) {
      candidates.push(direct);
    }
  }

  const next: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let value = "";
    if (typeof candidate === "string") {
      value = candidate;
    } else if (isRecord(candidate)) {
      const textCandidate =
        (typeof candidate["text"] === "string" && candidate["text"]) ||
        (typeof candidate["prompt"] === "string" && candidate["prompt"]) ||
        (typeof candidate["reply"] === "string" && candidate["reply"]) ||
        (typeof candidate["label"] === "string" && candidate["label"]) ||
        "";
      value = textCandidate;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const rewritten = toUserPromptSuggestion(trimmed);
    const safeSuggestion = rewritten.trim();
    if (!safeSuggestion) {
      continue;
    }
    const normalized = safeSuggestion.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    const limited = safeSuggestion.length > MAX_UI_SUGGESTED_REPLY_CHARS
      ? safeSuggestion.slice(0, MAX_UI_SUGGESTED_REPLY_CHARS).trimEnd()
      : safeSuggestion;
    if (!limited) {
      continue;
    }
    seen.add(normalized);
    next.push(limited);
    if (next.length >= MAX_UI_SUGGESTED_REPLIES) {
      break;
    }
  }
  return next;
}

/**
 * Suggested replies attached to action cards must not leak into the composer.
 * GitHub import requests carry a deterministic resume action; submitting their
 * historical prose suggestion would dispatch an unrelated AI run instead of
 * retrying the import API.
 *
 * A secret request is the same argument one step on: the card takes the value,
 * saves it and continues the run from its own button. A chip under the composer
 * offering "I added NOTION_API_KEY" is a fourth way to answer one question, and
 * the only one that can be pressed before the value exists.
 */
export function resolveComposerUiSuggestedReplies(message: ChatMessage | null | undefined): string[] {
  if (!message) {
    return [];
  }

  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType === "secret_request") {
    return [];
  }
  if (messageType === "integration_request") {
    const details = extractMessageDetails(message.metadata);
    const resumeActionCandidate = details?.["resumeAction"] ?? details?.["resume_action"];
    if (isRecord(resumeActionCandidate)) {
      const kind =
        typeof resumeActionCandidate["kind"] === "string"
          ? resumeActionCandidate["kind"].trim().toLowerCase()
          : "";
      if (kind === "github_import") {
        return [];
      }
    }
  }

  return resolveUiSuggestedReplies(message.metadata);
}

export function getTimelineHeading(messageType: string | null, details: Record<string, unknown> | null): string | null {
  switch (messageType) {
    case "command_execution":
      return "Command";
    case "mcp_tool_call":
      return "Tool call";
    case "runtime_switch":
      return "Runtime";
    case "todo_list":
      return "Plan";
    case "file_change":
      return "File changes";
    case "web_search":
      return "Web search";
    case "token_usage":
      return "Token usage";
    default: {
      if (details && typeof details.kind === "string") {
        return details.kind
          .replace(/^codex[_-]/i, "")
          .replace(/[_-]/g, " ")
          .replace(/\b\w/g, (match) => match.toUpperCase());
      }
      return null;
    }
  }
}

export function resolveTimelineStatusBadge(
  messageType: string | null,
  status: string | null,
): { label: string; className: string; showSpinner?: boolean } | null {
  if (!status) {
    return null;
  }
  const normalized = status.trim().toLowerCase();
  if (messageType === "runtime_switch") {
    if (normalized === "completed") {
      return null;
    }
    if (normalized === "in_progress") {
      return {
        label: "Switching",
        showSpinner: true,
        className: "flex items-center gap-1 border-primary-200 bg-primary-50 text-primary-600",
      };
    }
  }
  if (messageType === "command_execution" || messageType === "mcp_tool_call") {
    if (normalized === "completed") {
      return null;
    }
    if (normalized === "in_progress") {
      return {
        label: "",
        showSpinner: true,
        className: "flex items-center gap-1 border-primary-200 bg-primary-50 text-primary-600",
      };
    }
  }
  if (messageType === "local_capability_result") {
    if (normalized === "completed") {
      return null;
    }
    if (["in_progress", "started", "running"].includes(normalized)) {
      return {
        label: "",
        showSpinner: true,
        className: "flex items-center gap-1 border-primary-200 bg-primary-50 text-primary-600",
      };
    }
  }
  if (messageType === "reasoning") {
    if (normalized === "completed") {
      return null;
    }
    if (["in_progress", "started", "running"].includes(normalized)) {
      return {
        label: "Thinking",
        showSpinner: true,
        className: "flex items-center gap-1 border-primary-200 bg-primary-50 text-primary-600",
      };
    }
  }
  return resolveStatusBadge(status);
}

export function parseUsage(details: Record<string, unknown> | null): TokenUsageSummary | null {
  if (!details) {
    return null;
  }
  const usageValue = details["usage"];
  if (!isRecord(usageValue)) {
    return null;
  }
  const input = getNumberValue(usageValue, ["input_tokens", "inputTokens"]);
  const cached = getNumberValue(usageValue, ["cached_input_tokens", "cachedInputTokens"]);
  const output = getNumberValue(usageValue, ["output_tokens", "outputTokens"]);
  if (input === null && cached === null && output === null) {
    return null;
  }
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: cached ?? 0,
    outputTokens: output ?? 0,
    context: parsePromptContext(details),
  };
}

export function formatPromptContextModeLabel(context: PromptContextUsage): string {
  switch (context.mode) {
    case "provider_thread_restored":
      return "Thread reused";
    case "stateless_compacted":
      return "Context compacted";
    case "stateless_full":
      return "Stateless replay";
    default:
      return "Prompt context";
  }
}

export function formatTokenCountLabel(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value).toLocaleString();
}

export function extractChatClientIdentity(metadata: unknown): ChatClientIdentity | null {
  if (!metadata || !isRecord(metadata)) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const promptMetadata =
    isRecord(record["prompt_metadata"])
      ? (record["prompt_metadata"] as Record<string, unknown>)
      : isRecord(record["promptMetadata"])
        ? (record["promptMetadata"] as Record<string, unknown>)
        : record;

  const client = promptMetadata["client"];
  if (!isRecord(client)) {
    return null;
  }

  const userIdRaw = client["userId"] ?? client["user_id"];
  const sessionIdRaw = client["sessionId"] ?? client["session_id"];

  const userId = typeof userIdRaw === "string" && userIdRaw.trim().length > 0 ? userIdRaw.trim() : null;
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim().length > 0 ? sessionIdRaw.trim() : null;

  if (!userId && !sessionId) {
    return null;
  }

  return { userId, sessionId };
}

export function parseTemplateToolCall(details: Record<string, unknown> | undefined): TemplateToolCallInfo | null {
  if (!details || !isRecord(details)) {
    return null;
  }
  const tool = typeof details.tool === "string" ? details.tool : null;
  const server = typeof details.server === "string" ? details.server : null;
  if (tool !== "template.search" || (server && server !== "templates")) {
    return null;
  }

  const templatesValue = details.templates;
  const templates: TemplateOptionInfo[] = Array.isArray(templatesValue)
    ? templatesValue
        .map((entry) => (isRecord(entry) ? normalizeTemplateOption(entry as Record<string, unknown>) : null))
        .filter((value): value is TemplateOptionInfo => value !== null)
    : [];

  const selectionRecord = isRecord(details.selection) ? (details.selection as Record<string, unknown>) : null;
  const selectionNormalized = selectionRecord ? normalizeTemplateOption(selectionRecord) : null;

  let selection: TemplateOptionInfo | null = null;
  if (selectionNormalized) {
    const matched = templates.find((option) => option.id === selectionNormalized.id) ?? null;
    selection = mergeTemplateOptions(matched, selectionNormalized);
  } else if (templates.length > 0) {
    selection = templates[0];
  }

  const alternatives = templates.filter((option) => (selection ? option.id !== selection.id : true));

  return {
    selection,
    alternatives,
    total: templates.length,
  };
}

export function resolveBrowserToolRuntimeId(
  details: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null,
): string | null {
  const parseRuntimeId = (value: unknown): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const parseFromRecord = (record: Record<string, unknown> | null | undefined): string | null => {
    if (!record) {
      return null;
    }
    return (
      parseRuntimeId(record.runtimeId) ??
      parseRuntimeId(record.runtime_id) ??
      (isRecord(record.runtimePreference)
        ? parseRuntimeId((record.runtimePreference as Record<string, unknown>).runtimeId)
        : null) ??
      (isRecord(record.details)
        ? parseRuntimeId((record.details as Record<string, unknown>).runtimeId)
        : null)
    );
  };

  return parseFromRecord(details) ?? parseFromRecord(metadata);
}

export function isPlaywrightCliCommand(command: string | null | undefined): boolean {
  if (!command || typeof command !== "string") {
    return false;
  }
  const normalized = command.trim().toLowerCase();
  // Instafy browser automation attaches to a shared headed Chromium via CDP.
  // Detect the CDP attach call in the executed command payload.
  return normalized.includes("connectovercdp");
}

export function resolveBrowserSessionAutoOpenCandidate(message: ChatMessage): { runtimeId: string | null } | null {
  if (message.role !== "assistant" || !message.metadata || !isRecord(message.metadata)) {
    return null;
  }
  const metadata = message.metadata as Record<string, unknown>;
  const details = extractMessageDetails(metadata);
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();

  if (messageType === "command_execution") {
    const commandExecution = parseCommandExecutionOutput(message);
    if (!isPlaywrightCliCommand(commandExecution.command)) {
      return null;
    }
    const statusNormalized = (commandExecution.status ?? "").trim().toLowerCase();
    if (["failed", "error", "cancelled", "canceled", "blocked"].includes(statusNormalized)) {
      return null;
    }
    return { runtimeId: resolveBrowserToolRuntimeId(details, metadata) };
  }

  return null;
}

export function resolveTokenUsageForMessage(
  messages: ChatMessage[],
  messageId: string,
): TokenUsageSummary | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    return null;
  }

  const jobId = extractAgentJobId(messages[index]);
  if (jobId) {
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor];
      if (extractAgentJobId(candidate) !== jobId) {
        continue;
      }
      const parsed = extractTokenUsage(candidate);
      if (parsed) {
        return parsed;
      }
    }

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = messages[cursor];
      if (extractAgentJobId(candidate) !== jobId) {
        continue;
      }
      const parsed = extractTokenUsage(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  let startIndex = -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === "user") {
      startIndex = cursor;
      break;
    }
  }

  let endIndex = messages.length;
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    if (messages[cursor].role === "user") {
      endIndex = cursor;
      break;
    }
  }

  for (let cursor = endIndex - 1; cursor > startIndex; cursor -= 1) {
    const candidate = messages[cursor];
    const parsed = extractTokenUsage(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function parsePromptContext(details: Record<string, unknown> | null): PromptContextUsage | null {
  if (!details) {
    return null;
  }
  const contextValue = details["context"];
  if (!isRecord(contextValue)) {
    return null;
  }

  const mode = typeof contextValue["mode"] === "string" ? contextValue["mode"].trim() : "";
  const estimatedPromptTokens = getNumberValue(contextValue, ["estimatedPromptTokens"]);
  const estimatedPromptUsagePercent = getNumberValue(contextValue, ["estimatedPromptUsagePercent"]);
  const estimatedHistoryTokens = getNumberValue(contextValue, ["estimatedHistoryTokens"]);
  const modelContextWindow = getNumberValue(contextValue, ["modelContextWindow"]);
  const totalTurns = getNumberValue(contextValue, ["totalTurns"]);
  const includedTurns = getNumberValue(contextValue, ["includedTurns"]);
  const summarizedTurns = getNumberValue(contextValue, ["summarizedTurns"]);
  const omittedTurns = getNumberValue(contextValue, ["omittedTurns"]);

  if (
    !mode &&
    estimatedPromptTokens === null &&
    estimatedPromptUsagePercent === null &&
    estimatedHistoryTokens === null &&
    modelContextWindow === null &&
    totalTurns === null &&
    includedTurns === null &&
    summarizedTurns === null &&
    omittedTurns === null
  ) {
    return null;
  }

  return {
    mode: mode || null,
    estimatedPromptTokens,
    estimatedPromptUsagePercent,
    estimatedHistoryTokens,
    modelContextWindow,
    totalTurns,
    includedTurns,
    summarizedTurns,
    omittedTurns,
  };
}

function extractTokenUsage(message: ChatMessage): TokenUsageSummary | null {
  const details = extractMessageDetails(message.metadata);
  return parseUsage(details);
}

function normalizeTemplateOption(entry: Record<string, unknown>): TemplateOptionInfo | null {
  const idValue = entry.id;
  const labelValue = entry.label ?? entry.name;
  const id = typeof idValue === "string" ? idValue : null;
  const label = typeof labelValue === "string" ? labelValue : null;
  if (!id || !label) {
    return null;
  }

  const descriptionValue = entry.description;
  const description =
    typeof descriptionValue === "string" && descriptionValue.trim().length > 0
      ? descriptionValue.trim()
      : null;

  const tagsValue = entry.tags;
  const tags =
    Array.isArray(tagsValue) && tagsValue.length > 0
      ? tagsValue
          .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
          .map((tag) => tag.trim())
      : [];

  const creditCost = getNumberValue(entry, ["credit_cost", "creditCost"]);
  const source = formatTemplateSource(entry);

  return {
    id,
    label,
    description,
    tags,
    creditCost,
    source,
  };
}

function mergeTemplateOptions(
  primary: TemplateOptionInfo | null,
  fallback: TemplateOptionInfo | null,
): TemplateOptionInfo | null {
  if (!primary && !fallback) {
    return null;
  }
  if (!primary) {
    return fallback;
  }
  if (!fallback) {
    return primary;
  }
  return {
    id: primary.id || fallback.id,
    label: primary.label || fallback.label,
    description: primary.description ?? fallback.description,
    tags: primary.tags.length > 0 ? primary.tags : fallback.tags,
    creditCost: primary.creditCost ?? fallback.creditCost,
    source: primary.source ?? fallback.source,
  };
}

function formatTemplateSource(entry: Record<string, unknown>): string | null {
  const sourceValue = entry.source;
  if (!isRecord(sourceValue)) {
    return null;
  }
  const typeValue = sourceValue.type;
  if (typeof typeValue !== "string" || typeValue.trim().length === 0) {
    return null;
  }
  const normalizedType = typeValue.trim();

  switch (normalizedType) {
    case "git_repository": {
      const path = typeof sourceValue.path === "string" ? sourceValue.path : null;
      return path ? `Git repository · ${path}` : "Git repository";
    }
    case "workspace": {
      const workspaceId = typeof sourceValue.workspace_id === "string" ? sourceValue.workspace_id : null;
      return workspaceId ? `Space snapshot · ${workspaceId}` : "Space snapshot";
    }
    default: {
      return normalizedType.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
  }
}
