import type { ChatMessage } from "../types";
import { getControllerConversationNoticeKind } from "./controllerConversationNotice";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadataMessageType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

function mapDetailKindToMessageType(value: unknown): string | null {
  const normalized = normalizeMetadataMessageType(value);
  if (!normalized) {
    return null;
  }
  switch (normalized) {
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

export function extractMessageDetails(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || !isRecord(metadata)) {
    return null;
  }
  const details = metadata["details"];
  if (!isRecord(details)) {
    return null;
  }

  let resolved: Record<string, unknown> = details;
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = resolved["details"];
    if (!isRecord(nested)) {
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

export function getMessageType(message: ChatMessage): string | null {
  const directMessageType = normalizeMetadataMessageType(message.messageType);
  if (directMessageType) {
    return directMessageType;
  }
  if (message.metadata && isRecord(message.metadata)) {
    const direct = normalizeMetadataMessageType(message.metadata["messageType"]);
    if (direct) {
      return direct;
    }
    const snake = normalizeMetadataMessageType(message.metadata["message_type"]);
    if (snake) {
      return snake;
    }
    const details = extractMessageDetails(message.metadata);
    if (details) {
      const nestedDirect = normalizeMetadataMessageType(details["messageType"]);
      if (nestedDirect) {
        return nestedDirect;
      }
      const nestedSnake = normalizeMetadataMessageType(details["message_type"]);
      if (nestedSnake) {
        return nestedSnake;
      }
      const nestedType = normalizeMetadataMessageType(details["type"]);
      if (nestedType && ["command_execution", "mcp_tool_call", "web_search", "todo_list"].includes(nestedType)) {
        return nestedType;
      }
      const mapped = mapDetailKindToMessageType(details["kind"]);
      if (mapped) {
        return mapped;
      }
    }
  }
  return getControllerConversationNoticeKind(message);
}
