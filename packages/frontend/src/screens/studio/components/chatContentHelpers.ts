import type { ChatMessage } from "../types";
import { summarizeCommandOutputForPreview } from "./CommandOutputBlock";
import { extractMessageDetails } from "./chatMessageMetadata";
import { stripShellWrapperFromCommand } from "./threadPreviewHelpers";

const URL_TRAILING_PUNCTUATION_REGEX = /[)\]}>.,!?;:'"`]+$/;
const URL_IN_TEXT_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeUrlCandidate(raw: string): string {
  let value = raw.trim();
  while (value) {
    const next = value.replace(URL_TRAILING_PUNCTUATION_REGEX, "");
    if (next === value) {
      break;
    }
    value = next;
  }
  return value;
}

function extractBestUrlFromText(text: string): string | null {
  const matches = text.match(URL_IN_TEXT_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const sanitized = sanitizeUrlCandidate(matches[index] ?? "");
    if (sanitized) {
      return sanitized;
    }
  }
  return null;
}

function extractCommandOutputFromSummary(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.toLowerCase().includes("terminal session")) {
    return null;
  }
  const parts = trimmed.split(/\n{2,}/);
  if (parts.length < 2) {
    return null;
  }
  const candidate = parts[parts.length - 1]?.trim();
  return candidate && candidate.length > 0 ? candidate : null;
}

function looksLikeTrivialCommandOutputPreview(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.length <= 6 && /^[\]{}(),;]+$/.test(trimmed);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).trimEnd() + "…";
}

export function truncateMultiline(value: string, maxLength: number): { text: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxLength).trimEnd(), truncated: true };
}

export function normalizeActivityText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const wrapped = trimmed.match(/^(\*\*|__)([\s\S]+)\1$/);
  const unwrapped = wrapped && wrapped[2] ? wrapped[2].trim() : trimmed;
  const leadingEmphasis = unwrapped.match(/^(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s+([\s\S]+)$/);
  const normalizedSource =
    leadingEmphasis && leadingEmphasis[1] && leadingEmphasis[2]
      ? `${leadingEmphasis[1].trim()} | ${leadingEmphasis[2].trim()}`
      : unwrapped;
  return normalizedSource
    .replace(/^activity\b\s*[·|:]\s*/i, "")
    .replace(/^activity\b\s+/i, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
}

export function splitActivityLeadAndDetails(value: string): { lead: string; details: string | null } {
  const text = value.trim();
  if (!text) {
    return { lead: "", details: null };
  }
  const separatorIndex = text.indexOf(" | ");
  if (separatorIndex <= 0) {
    return { lead: text, details: null };
  }
  const lead = text.slice(0, separatorIndex).trim();
  const details = text.slice(separatorIndex + 3).trim();
  if (!lead || !details) {
    return { lead: text, details: null };
  }
  return { lead, details };
}

export function stripWorkspacePrefixForPreview(value: string): string {
  return value
    .replace(/\/workspace\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//gi, "")
    .replace(/\/workspace\//gi, "");
}

export function summarizeCommandInvocationForPreview(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const command = stripShellWrapperFromCommand(normalized);
  return truncate(command, maxLength);
}

/**
 * The result half of a command preview — the best URL in the output, else the
 * output's last meaningful line — without the command itself. Empty when the
 * output has nothing worth summarizing.
 */
export function summarizeCommandExecutionResultForPreview(
  output: string | null | undefined,
  maxLength = 160,
): string {
  const outputText = typeof output === "string" ? output : "";
  if (!outputText) {
    return "";
  }
  const url = extractBestUrlFromText(outputText);
  if (url) {
    return url;
  }
  const outputPreview = summarizeCommandOutputForPreview(outputText, maxLength);
  return outputPreview && !looksLikeTrivialCommandOutputPreview(outputPreview) ? outputPreview : "";
}

function unwrapCommandInvocation(value: string): string {
  let command = value.replace(/\s+/g, " ").trim();
  if (!command) {
    return "";
  }
  for (let index = 0; index < 3; index += 1) {
    command = command.replace(/\\(['"])/g, "$1");
    const quotedShellWrapped = command.match(/^(?:\/[\w./-]+\/)?(?:bash|zsh|sh)\s+-lc\s+(['"])([\s\S]*)\1$/i);
    if (quotedShellWrapped?.[2]) {
      command = quotedShellWrapped[2].replace(/\s+/g, " ").trim();
      continue;
    }
    const flattenedShellWrapped = command.match(/^(?:\/[\w./-]+\/)?(?:bash|zsh|sh)\s+-lc\s+([\s\S]+)$/i);
    if (!flattenedShellWrapped?.[1]) {
      break;
    }
    command = flattenedShellWrapped[1].replace(/\s+/g, " ").trim();
  }
  return command;
}

function extractQuotedCommandTopic(command: string): string | null {
  const quoted = command.match(/(["'])([^"']{3,120})\1/);
  if (quoted?.[2]) {
    return truncate(stripWorkspacePrefixForPreview(quoted[2].trim()), 64);
  }
  return null;
}

export function summarizeActiveCommandForPreview(value: string, maxLength = 120): string {
  const command = unwrapCommandInvocation(value);
  if (!command || /^running command\.{0,3}$/i.test(command)) {
    return "";
  }
  const normalized = command.toLowerCase();
  const topic = extractQuotedCommandTopic(command);

  if (normalized.startsWith("instafy conversation search")) {
    return topic ? `Searching prior chats for "${topic}"…` : "Searching prior chats…";
  }
  if (normalized.startsWith("instafy conversation show")) {
    return "Opening prior conversation…";
  }
  if (normalized.startsWith("instafy secrets")) {
    // Never the raw invocation: it carries the space id, and a shell line at
    // message weight during a first run is the thing setup promised not to do.
    return "Checking which values this space already has…";
  }
  if (normalized.startsWith("instafy agents context ")) {
    return topic ? `Checking saved agent context for "${topic}"…` : "Checking saved agent context…";
  }
  if (
    normalized.includes(".codex-runtime") ||
    normalized.includes(".codex/sessions") ||
    normalized.includes("runtime log")
  ) {
    return "Checking prior context…";
  }
  if (/(^|[;&|]\s*)(rg|grep)\b/.test(normalized)) {
    return topic ? `Searching workspace for "${topic}"…` : "Searching workspace…";
  }
  if (/\bgit\s+clone\b/.test(normalized)) {
    return "Cloning source repo…";
  }
  if (/(^|[;&|]\s*)find\b|\bfind\s+["'$./\w-]/.test(normalized)) {
    return "Scanning workspace files…";
  }
  if (/^git\b/.test(normalized)) {
    return "Checking Git state…";
  }
  if (/^(pnpm|npm|yarn)\s+(test|run\s+test)\b/.test(normalized) || /^cargo\s+test\b/.test(normalized)) {
    return "Running tests…";
  }
  if (/^(pnpm|npm|yarn|cargo)\b/.test(normalized)) {
    return "Running project command…";
  }
  if (/^(python3?|node|deno)\b/.test(normalized)) {
    return "Running script…";
  }
  return summarizeCommandInvocationForPreview(command, maxLength);
}

export function summarizeCommandExecutionUpdateForPreview(
  invocation: string,
  output: string | null | undefined,
): string {
  const outputText = typeof output === "string" ? output : "";
  const url = outputText ? extractBestUrlFromText(outputText) : null;
  const commandPreview = summarizeCommandInvocationForPreview(invocation, url ? 110 : 160);

  if (url) {
    return commandPreview ? `${commandPreview} -> ${url}` : url;
  }

  const outputPreview = outputText ? summarizeCommandOutputForPreview(outputText, 160) : "";
  if (outputPreview && !looksLikeTrivialCommandOutputPreview(outputPreview)) {
    return commandPreview ? `${commandPreview} -> ${outputPreview}` : outputPreview;
  }

  return commandPreview || invocation.replace(/\s+/g, " ").trim();
}

export function parseCommandExecutionOutput(
  message: ChatMessage,
): { output: string | null; status: string | null; command: string | null } {
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = extractMessageDetails(metadata);
  const detailsEvent = details && isRecord(details["event"]) ? (details["event"] as Record<string, unknown>) : null;

  const statusFromDetails = details && typeof details["status"] === "string" ? (details["status"] as string) : null;
  const statusFromEvent =
    detailsEvent && typeof detailsEvent["status"] === "string" ? (detailsEvent["status"] as string) : null;
  const statusFromMetadata =
    metadata && typeof metadata["status"] === "string" ? (metadata["status"] as string) : null;
  const loweredContent = message.content.toLowerCase();
  const statusFromSummary = loweredContent.includes("command failed")
    ? "failed"
    : loweredContent.includes("command timed out")
      ? "failed"
      : loweredContent.includes("command completed")
        ? "completed"
        : null;
  const status = statusFromDetails ?? statusFromEvent ?? statusFromMetadata ?? statusFromSummary;

  const outputValue =
    (details && typeof details["aggregatedOutput"] === "string" && (details["aggregatedOutput"] as string)) ||
    (details && typeof details["aggregated_output"] === "string" && (details["aggregated_output"] as string)) ||
    (detailsEvent &&
      typeof detailsEvent["aggregatedOutput"] === "string" &&
      (detailsEvent["aggregatedOutput"] as string)) ||
    (detailsEvent &&
      typeof detailsEvent["aggregated_output"] === "string" &&
      (detailsEvent["aggregated_output"] as string)) ||
    (metadata && typeof metadata["aggregatedOutput"] === "string" && (metadata["aggregatedOutput"] as string)) ||
    (metadata && typeof metadata["aggregated_output"] === "string" && (metadata["aggregated_output"] as string)) ||
    extractCommandOutputFromSummary(message.content) ||
    null;

  const commandValue =
    (details && typeof details["command"] === "string" && (details["command"] as string)) ||
    (detailsEvent && typeof detailsEvent["command"] === "string" && (detailsEvent["command"] as string)) ||
    (metadata && typeof metadata["command"] === "string" && (metadata["command"] as string)) ||
    message.content ||
    null;

  return {
    output: typeof outputValue === "string" && outputValue.trim().length > 0 ? outputValue : null,
    status,
    command: typeof commandValue === "string" && commandValue.trim().length > 0 ? commandValue.trim() : null,
  };
}

export function parseTodoItems(details: Record<string, unknown> | null): Array<{ text: string; completed: boolean }> {
  if (!details) {
    return [];
  }
  const itemsValue = details["items"];
  if (!Array.isArray(itemsValue)) {
    return [];
  }
  return itemsValue
    .filter(isRecord)
    .map((item) => {
      const text = typeof item["text"] === "string" ? item["text"].trim() : "";
      const completed = typeof item["completed"] === "boolean" ? item["completed"] : false;
      return { text, completed };
    })
    .filter((item) => item.text.length > 0);
}
