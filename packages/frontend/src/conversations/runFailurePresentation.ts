import type { ChatMessage } from "../screens/studio/types";

/**
 * Presentation helpers for failed agent runs.
 *
 * The stored assistant message keeps the raw technical failure text (it is
 * canonical for debugging); these helpers only decide how the frontend
 * DISPLAYS that text: a short friendly sentence up front with the raw text
 * available behind a quiet "Details" disclosure.
 */

export type RunFailureKind =
  | "missing_final_message"
  | "no_workspace_changes"
  | "missing_verification"
  | "needs_ai"
  | "generic";

export type RunFailurePresentation = {
  kind: RunFailureKind;
  friendlyText: string;
  rawText: string;
};

const RUN_FAILURE_FRIENDLY_TEXT: Record<RunFailureKind, string> = {
  missing_final_message:
    "The reply didn't come through — this is usually a temporary provider hiccup.",
  no_workspace_changes: "The file changes didn't come through.",
  missing_verification: "The run ended before it could verify its work.",
  needs_ai:
    "I couldn't find a connected AI credential for this run. Connect or reconnect a provider, then try again.",
  generic: "Something went wrong finishing this run.",
};

export const RETRYING_STATUS_DISPLAY_TEXT = "Taking another pass…";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedStringField(metadata: Record<string, unknown> | null, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasJobReference(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) {
    return false;
  }
  return [metadata["jobId"], metadata["job_id"], metadata["runId"], metadata["run_id"]].some(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
}

/**
 * True when message metadata marks the message as the terminal output of a
 * failed agent run (`build_agent_message_metadata` emits `source: "agent"`,
 * `outcome: "failed"`, `messageType: "error"`, plus job/run ids).
 */
export function hasFailedRunMetadata(metadata: unknown): boolean {
  const record = isRecord(metadata) ? metadata : null;
  if (!record) {
    return false;
  }
  const outcome = normalizedStringField(record, "outcome") || normalizedStringField(record, "status");
  if (outcome !== "failed" && outcome !== "failure" && outcome !== "error") {
    return false;
  }
  const source = normalizedStringField(record, "source");
  return source === "agent" || hasJobReference(record);
}

const MISSING_FINAL_MESSAGE_PATTERNS = [
  /without returning a final assistant message/i,
  /stopped after a progress update/i,
  /without returning the required final json/i,
  /without returning a valid final assistant json/i,
  /returned assistant text instead of the required final json/i,
];

const NO_WORKSPACE_CHANGES_PATTERNS = [
  /did not apply any workspace changes/i,
  /listed file changes, but no files were actually written/i,
  /requires workspace file changes, but the codex reply produced no files/i,
];

const MISSING_VERIFICATION_PATTERNS = [
  /command observation required by runtime routing/i,
  /did not execute the command observation/i,
  /did not execute any non-browser mcp tool calls/i,
  /requires mcp tool usage, but the codex reply did not execute/i,
];

// Failures whose real cause is a missing/removed AI credential (e.g. the
// controller can't resolve the credential the run was dispatched with). These
// are surfaced with a "Connect AI" action rather than a retry, which won't help.
const NEEDS_AI_PATTERNS = [
  /credential not found/i,
  /no default credential/i,
  /requires user credentials/i,
  /no ai (?:credential|provider)s? (?:is )?(?:connected|configured|available)/i,
];

/**
 * Failure kinds that are safe to re-dispatch automatically. Both are transient:
 * `missing_final_message` is a provider hiccup that usually resolves on a fresh
 * attempt, and `no_workspace_changes` is a reply that dropped its file writes.
 * `missing_verification` and `generic` are excluded because retrying rarely
 * helps and/or the underlying cause is deterministic.
 */
export const AUTO_RETRY_ELIGIBLE_KINDS = [
  "missing_final_message",
  "no_workspace_changes",
] as const satisfies readonly RunFailureKind[];

/** Maximum automatic re-dispatches allowed for a single originating prompt. */
export const MAX_AUTO_RETRIES_PER_ORIGIN = 1;

export function isAutoRetryEligibleFailureKind(kind: RunFailureKind | null | undefined): boolean {
  return kind != null && (AUTO_RETRY_ELIGIBLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Stable key for the originating prompt of a failed run. Every automatic retry
 * re-submits the same prompt text, so a normalized (trimmed + whitespace
 * collapsed + lowercased) copy of that text is stable across the retry chain
 * and lets us bound how many times any one prompt may auto-retry. Returns "" for
 * empty input.
 */
export function runFailureOriginKey(promptText: string): string {
  return promptText.trim().replace(/\s+/g, " ").toLowerCase();
}

export function classifyRunFailureText(rawText: string): Exclude<RunFailureKind, "generic"> | null {
  if (MISSING_FINAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return "missing_final_message";
  }
  if (NO_WORKSPACE_CHANGES_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return "no_workspace_changes";
  }
  if (MISSING_VERIFICATION_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return "missing_verification";
  }
  if (NEEDS_AI_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return "needs_ai";
  }
  return null;
}

/**
 * Resolve the friendly presentation for a failed-run message body.
 *
 * Returns null when the message should keep its current rendering (unknown
 * text without failed-run metadata, or empty content). Callers that already
 * surface curated guidance (proxy/credential errors) must gate before calling.
 *
 * `assumeFailed` lets surfaces that already display a failure signal (the
 * rose "Run failed" chip, the danger error bubble) opt into the specific
 * pattern-matched sentences even when the message metadata lacks an outcome;
 * the generic sentence still requires failed-run metadata so ordinary text is
 * never rewritten.
 */
export function resolveRunFailurePresentation(params: {
  metadata?: unknown;
  content: string;
  assumeFailed?: boolean;
}): RunFailurePresentation | null {
  const metadata = isRecord(params.metadata) ? params.metadata : null;
  const errorMessage =
    typeof metadata?.["errorMessage"] === "string" ? metadata["errorMessage"].trim() : "";
  const content = params.content.trim();
  const rawText = errorMessage || content;
  if (!rawText) {
    return null;
  }
  const failedByMetadata = hasFailedRunMetadata(metadata);
  if (!failedByMetadata && !params.assumeFailed) {
    return null;
  }
  const kind = classifyRunFailureText(rawText) ?? (failedByMetadata ? "generic" : null);
  if (!kind) {
    return null;
  }
  return { kind, friendlyText: RUN_FAILURE_FRIENDLY_TEXT[kind], rawText };
}

export type RetryingStatusPresentation = {
  displayText: string;
  fullText: string;
};

/**
 * Map interim "Retrying: <technical reason>" status lines to a calm display
 * label. The stored message is untouched; the full original line is returned
 * so callers can expose it as a title/tooltip.
 */
export function resolveRetryingStatusPresentation(params: {
  metadata?: unknown;
  content: string;
}): RetryingStatusPresentation | null {
  const content = params.content.trim();
  const metadata = isRecord(params.metadata) ? params.metadata : null;
  const kind = normalizedStringField(metadata, "kind");
  if (kind === "codex_retry") {
    return {
      displayText: RETRYING_STATUS_DISPLAY_TEXT,
      fullText: content || RETRYING_STATUS_DISPLAY_TEXT,
    };
  }
  if (/^retrying:/i.test(content)) {
    return { displayText: RETRYING_STATUS_DISPLAY_TEXT, fullText: content };
  }
  return null;
}

/**
 * Resolve the prompt text to re-submit for a failed run: the nearest user
 * message preceding the failure message. The failure message is located by id
 * when it is part of the conversation, otherwise by timestamp (synthesized
 * terminal messages from run records are not stored in the conversation).
 */
export function resolveRunFailureRetryPrompt(params: {
  conversationMessages: ChatMessage[];
  failureMessage: Pick<ChatMessage, "id" | "timestamp">;
}): string | null {
  const { conversationMessages, failureMessage } = params;
  let searchFrom = conversationMessages.findIndex((message) => message.id === failureMessage.id);
  if (searchFrom < 0) {
    searchFrom = conversationMessages.length;
    const failureTimestamp =
      typeof failureMessage.timestamp === "number" && Number.isFinite(failureMessage.timestamp)
        ? failureMessage.timestamp
        : null;
    if (failureTimestamp !== null) {
      while (searchFrom > 0) {
        const candidate = conversationMessages[searchFrom - 1];
        const timestamp =
          typeof candidate.timestamp === "number" && Number.isFinite(candidate.timestamp)
            ? candidate.timestamp
            : null;
        if (timestamp !== null && timestamp > failureTimestamp) {
          searchFrom -= 1;
          continue;
        }
        break;
      }
    }
  }
  for (let index = Math.min(searchFrom, conversationMessages.length) - 1; index >= 0; index -= 1) {
    const candidate = conversationMessages[index];
    if (candidate.role === "user" && candidate.content.trim().length > 0) {
      return candidate.content;
    }
  }
  return null;
}
