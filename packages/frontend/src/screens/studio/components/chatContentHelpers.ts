import type { ChatMessage } from "../types";
import { extractMessageDetails } from "./chatMessageMetadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
