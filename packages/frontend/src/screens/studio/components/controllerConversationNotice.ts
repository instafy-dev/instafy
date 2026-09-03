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

/// Mirrors `runtime_alert_fallback_message` in
/// packages/runtime-controller/src/dispatch.rs. Both sides used to say "Use the
/// Runtime button by the composer"; that button's only renderer
/// (`RuntimeSelectorCompact`) lost its last importer, so the copy pointed at a
/// control that does not exist. Machines is where runtimes live now, and
/// `resolveControllerConversationNoticeAction` puts a button on the card.
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
        : "Workspace startup failed. Open Machines to reconnect Instafy Cloud.";
    case "runtime_unavailable":
      return "No runtime is connected for this space. Open Machines to start Instafy Cloud.";
    case "runtime_inspection_failed":
      return "The workspace runtime could not be verified. Open Machines to inspect or reconnect it.";
    case "automation_launch_failed":
      // The controller wrote the actual cause into the message.
      return legacyContent?.trim() || "This scheduled run couldn't start.";
    default:
      return "The workspace runtime could not be reached. Open Machines to inspect or reconnect it.";
  }
}

/// The controller's own sentence for a schedule pinned to a machine that was
/// not online. `select_viable_runtime_id` matches the provider exactly, so only
/// *that* machine satisfies the run — which is why the card offers the
/// self-host dialog rather than anything that claims to start a runtime here.
/// Pinned on the Rust side by SELF_HOSTED_LAUNCH_MARKER; edit both together.
const SELF_HOSTED_LAUNCH_MARKER = "no self-hosted runtime was online for this space";

export type ControllerConversationNoticeAction = {
  label: string;
  kind: "open_machines" | "desktop_runtime_help";
};

/**
 * The one action a controller notice offers, or null when there is nothing
 * honest to offer. Deliberately narrow: navigation and instructions only. A
 * self-hosted runtime cannot be started from the browser at all, and re-running
 * an automation is owner-gated while this card is visible to every
 * participant — a button for either would fail for the reader who pressed it.
 */
export function resolveControllerConversationNoticeAction(
  message: ChatMessage,
): ControllerConversationNoticeAction | null {
  if (getControllerConversationNoticeKind(message) !== "runtime_alert") {
    return null;
  }
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = extractMessageDetails(metadata);
  const reason = normalizeString(details?.["reason"] ?? metadata?.["reason"]);

  if (reason === "automation_launch_failed") {
    return message.content.includes(SELF_HOSTED_LAUNCH_MARKER)
      ? { label: "How to start it", kind: "desktop_runtime_help" }
      : { label: "Open Machines", kind: "open_machines" };
  }
  // A start that is still in flight resolves itself; the card says so.
  if (reason === "runtime_not_ready" && isRecoverableRuntimeStartAlert(details, message.content)) {
    return null;
  }
  return { label: "Open Machines", kind: "open_machines" };
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
  if (normalizeString(details?.["reason"] ?? metadata?.["reason"]) === "automation_launch_failed") {
    return "Scheduled run couldn't start";
  }
  return isRecoverableRuntimeStartAlert(details, message.content)
    ? "Workspace starting"
    : "Workspace unavailable";
}
