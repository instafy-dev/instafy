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
/// Runtime button by the composer"; that button's only renderer lost its last
/// importer and has since been deleted, so the copy pointed at a control that
/// does not exist. Machines is where runtimes live now, and
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
  kind: "open_machines" | "desktop_runtime_help" | "open_credits" | "run_automation";
  /** Set only for "run_automation". */
  automationId?: string;
};

/**
 * Causes where running the schedule again could plausibly go differently. The
 * platform was full, the controller stumbled, or the provider call failed —
 * all transient. Deliberately excludes insufficient_credits and
 * runtime_limit_reached: the cause is still true, so a retry fails again in
 * front of whoever pressed it.
 */
const RETRYABLE_FAILURE_CODES = new Set([
  "platform_at_capacity",
  "controller_unavailable",
  "provider_launch_failed",
]);

/**
 * Causes the controller can name, mirrored from
 * packages/runtime-controller/src/automations.rs (the CODE_* constants and the
 * codes forwarded from runtime/ensure.rs). Each side has a test pinning the
 * vocabulary, so renaming one half fails CI instead of silently dropping a
 * button. A code absent from this map — including no code at all, which is
 * every notice written before the controller carried one — falls through to
 * the legacy behaviour below.
 */
const ACTION_BY_FAILURE_CODE: Record<string, ControllerConversationNoticeAction | null> = {
  self_hosted_runtime_offline: { label: "How to start it", kind: "desktop_runtime_help" },
  insufficient_credits: { label: "Open credits", kind: "open_credits" },
  // The runtime holding the last slot is on that page, and stopping it is the
  // actual fix.
  runtime_limit_reached: { label: "Open Machines", kind: "open_machines" },
  // Nothing the reader can press changes any of these, so they get no button:
  // the platform is full, the schedule's provider needs editing, the space is
  // gone, or it is transient and resolves itself.
  platform_at_capacity: null,
  hosted_provider_unsupported: null,
  automation_access_denied: null,
  controller_unavailable: null,
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
  viewer?: { viewerUserId?: string | null },
): ControllerConversationNoticeAction | null {
  if (getControllerConversationNoticeKind(message) !== "runtime_alert") {
    return null;
  }
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = extractMessageDetails(metadata);
  const reason = normalizeString(details?.["reason"] ?? metadata?.["reason"]);

  if (reason === "automation_launch_failed") {
    const failureCode = normalizeString(details?.["failureCode"]);
    // Re-running is owner-gated in the controller
    // (`can_access_owned_automation`), while this card is visible to every
    // conversation participant. Offering it to anyone else would 403 for the
    // person who pressed it.
    const automationId = normalizeString(details?.["automationId"]);
    const ownerId = normalizeString(details?.["automationOwnerId"]);
    const viewerId = normalizeString(viewer?.viewerUserId);
    if (
      automationId &&
      ownerId &&
      viewerId &&
      ownerId === viewerId &&
      failureCode &&
      RETRYABLE_FAILURE_CODES.has(failureCode)
    ) {
      return { label: "Run now", kind: "run_automation", automationId };
    }
    if (failureCode && failureCode in ACTION_BY_FAILURE_CODE) {
      return ACTION_BY_FAILURE_CODE[failureCode] ?? null;
    }
    // No code, or one this build does not know: every notice stored before the
    // controller carried a code lands here, and the prose is all we have.
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
