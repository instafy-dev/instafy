import type { ChatMessage } from "../types";
import { isRecoverableRuntimeStartAlert } from "./runtimeAlertPresentation";

export type ControllerConversationNoticeKind = "runtime_alert" | "run_cancellation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function extractMessageDetails(
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

function resolveRuntimeAlertContent(
  metadata: Record<string, unknown> | null,
  legacyContent?: string | null,
): string {
  const details = extractMessageDetails(metadata);
  const reason = normalizeString(details?.["reason"] ?? metadata?.["reason"]);

  switch (reason) {
    case "runtime_not_ready":
      return isRecoverableRuntimeStartAlert(details, legacyContent)
        ? "Starting the workspace. Your queued request will continue automatically."
        : "Workspace startup failed. Use the Runtime button by the composer to reconnect Instafy Cloud.";
    case "runtime_unavailable":
      return "No runtime is connected for this space. Use the Runtime button by the composer to start Instafy Cloud.";
    case "runtime_inspection_failed":
      return "The workspace runtime could not be verified. Use the Runtime button by the composer to inspect or reconnect it.";
    default:
      return "The workspace runtime could not be reached. Use the Runtime button by the composer to inspect or reconnect it.";
  }
}

export function getControllerConversationNoticeKind(
  message: ChatMessage,
): ControllerConversationNoticeKind | null {
  if (typeof message.authorId === "string" && message.authorId.trim().length > 0) {
    return null;
  }
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  if (!metadata) {
    return null;
  }
  if (normalizeString(metadata["source"]) !== "controller") {
    return null;
  }
  const kind = normalizeString(metadata["kind"]);
  return kind === "runtime_alert" || kind === "run_cancellation" ? kind : null;
}

export function extractControllerConversationNoticeStatus(message: ChatMessage): string | null {
  const kind = getControllerConversationNoticeKind(message);
  if (!kind) {
    return null;
  }

  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = extractMessageDetails(metadata);
  const candidates: unknown[] = [
    details?.["finalStatus"],
    details?.["runStatus"],
    details?.["status"],
    details?.["outcome"],
    metadata?.["status"],
    metadata?.["outcome"],
  ];
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return kind === "run_cancellation" ? "canceled" : "failed";
}

export function resolveControllerConversationNoticeContent(message: ChatMessage): string {
  const kind = getControllerConversationNoticeKind(message);
  if (kind !== "runtime_alert") {
    return message.content;
  }

  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  return resolveRuntimeAlertContent(metadata, message.content);
}

export function resolveControllerConversationNoticeLabel(message: ChatMessage): string {
  const kind = getControllerConversationNoticeKind(message);
  if (kind !== "runtime_alert") {
    return "Run canceled";
  }

  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = extractMessageDetails(metadata);
  return isRecoverableRuntimeStartAlert(details, message.content)
    ? "Workspace starting"
    : "Workspace unavailable";
}
