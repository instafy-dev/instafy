import { isPersonRuntimeStopReason } from "../runtime/unexpectedHostedRuntimeRecovery";
import { resolveProxyUpstreamErrorGuidance } from "../screens/studio/components/proxyError";
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
  | "provider_rate_limited"
  | "provider_usage_limit"
  | "response_incomplete"
  | "browser_page_missing"
  | "interrupted_run_expired"
  | "ai_unavailable"
  | "generic";

export type RunFailurePresentation = {
  kind: RunFailureKind;
  friendlyText: string;
  rawText: string;
  /** The failure block offers "Manage AI": the person's own AI connection can fix it. */
  manageAi?: boolean;
};

// What a person reads for a failed turn. Plain words only: never "upstream",
// "provider", "credential", "runtime", "switch", "Codex", "workspace" or
// "request", which name the plumbing; the raw text keeps them behind Details.
const RUN_FAILURE_FRIENDLY_TEXT: Record<RunFailureKind, string> = {
  missing_final_message:
    "The reply didn't come through. This is usually temporary.",
  // Used when the failure names no agent; see noChangesFriendlyText.
  no_workspace_changes: "Octo didn't finish the changes.",
  missing_verification: "The turn ended before it could check its work.",
  needs_ai:
    "No AI is connected for this turn. Connect AI, then try again.",
  // The proxy reports a spent ChatGPT plan window with the same 429 text as a
  // short throttle, so this copy cannot promise when a retry will work.
  provider_rate_limited:
    "The AI is busy right now, so this turn stopped. Wait a little, then try again. If it keeps happening, its usage limit may have been reached.",
  // Used when the run's AI access is not known; see
  // providerUsageLimitFriendlyText for Instafy AI and for the person's own.
  provider_usage_limit:
    "The AI account for this turn has reached its usage limit, so it stopped. Try again after the limit resets, or connect another AI.",
  // Used when the provider gave a reason this copy does not name; see
  // INCOMPLETE_RESPONSE_FRIENDLY_TEXT for the ones it does.
  response_incomplete:
    "The AI stopped the answer before it was finished, so this turn stopped. Try again, or ask for less at once.",
  browser_page_missing:
    "This was sent as a browser task without a page to work on, so nothing ran. Try again from Chat, or open a page in the browser first.",
  // Used when the stop was not a person's; see interruptedRunExpiredFriendlyText.
  interrupted_run_expired:
    "This turn lost its machine and didn't pick up again in time. Try again to continue.",
  // Used for Instafy AI; see aiUnavailablePresentation for the person's own.
  ai_unavailable: "Instafy AI isn't answering right now.",
  // An unclassified failure surfaces its real reason inline when that reason
  // is plain words (see inlineGenericFailureText); otherwise this sentence.
  generic: "Something went wrong, so this turn stopped.",
};

// Words and marks that name the plumbing. A raw failure reason that uses one
// stays behind Details, and the failure block says the plain sentence instead.
// (The controller's own sentences, such as a team's cloud runtimes staying
// busy, are written for the person and still show.)
const TECHNICAL_FAILURE_WORDS =
  /\b(?:codex|workspace|requests?|providers?|upstream|credentials?|preflight|mcp|json|https?|url|proxy|stderr|stdout|exit (?:code|status)|status \d{3})\b|[`{}<>]|::/i;

const MAX_AGENT_NAME_LENGTH = 40;

/**
 * The name of the agent whose turn failed, as the failure message's own
 * metadata names it ({ agent: { displayName } }), or null. A name that is not
 * a short plain one is left out.
 */
function failedAgentName(metadata: Record<string, unknown> | null): string | null {
  const agent = metadata && isRecord(metadata["agent"]) ? metadata["agent"] : null;
  const name = typeof agent?.["displayName"] === "string" ? agent["displayName"].trim() : "";
  if (!name || name.length > MAX_AGENT_NAME_LENGTH || /[^\p{L}\p{N} .'’-]/u.test(name)) {
    return null;
  }
  return name;
}

function noChangesFriendlyText(metadata: Record<string, unknown> | null): string {
  const name = failedAgentName(metadata);
  return name ? `${name} didn't finish the changes.` : RUN_FAILURE_FRIENDLY_TEXT.no_workspace_changes;
}

/** Longest inline failure reason before it is truncated (…) with the full text
 * kept behind the Details disclosure. */
const GENERIC_INLINE_FAILURE_MAX_LENGTH = 240;

/**
 * For an unclassified ("generic") failure there is no friendlier summary than
 * the real reason, so surface it inline instead of a canned sentence (#145):
 * the first meaningful line, bounded in length. The full raw text stays
 * available behind the Details disclosure.
 */
function inlineGenericFailureText(rawText: string): string {
  const firstLine =
    rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? rawText.trim();
  if (!firstLine || TECHNICAL_FAILURE_WORDS.test(firstLine)) {
    return RUN_FAILURE_FRIENDLY_TEXT.generic;
  }
  if (firstLine.length <= GENERIC_INLINE_FAILURE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, GENERIC_INLINE_FAILURE_MAX_LENGTH - 1).trimEnd()}…`;
}

export const RETRYING_STATUS_DISPLAY_TEXT = "Trying again…";

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
  /reported file changes but no workspace files were written/i,
];

const MISSING_VERIFICATION_PATTERNS = [
  /command observation required by runtime routing/i,
  /did not execute the command observation/i,
  /did not execute any non-browser mcp tool calls/i,
  /requires mcp tool usage, but the codex reply did not execute/i,
];

// A browser task the runtime refused before doing anything because it named no
// usable browser page. Studio from before the composer's open-page guard (or a
// send-queue entry such a tab created) could dispatch one without a page, and
// current Studio can still target a page inferred from chat history, whose id
// is its URL. The controller now refuses both at send time, so this covers runs
// that failed before that.
const BROWSER_PAGE_MISSING_PATTERNS = [
  /missing its UI-selected browserPageId/i,
  /requires the job's UI-selected browserPageId/i,
  /browserPageId must be one bounded CDP target id/i,
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

// The model provider answered 429 and the run stopped. Codex reports it as
// "exceeded retry limit, last status: 429 Too Many Requests" even though no
// retry happened, and the Instafy proxy labels it upstream_rate_limit. Proxy
// errors that still read "unexpected status 429" are `ai_unavailable`
// instead (resolveRunFailurePresentation reads them before this list).
// A bare "429 Too Many Requests" is not enough: a throttled skill import or the
// scoped worker proxy fail with that same phrase, and neither is the AI
// provider.
// The controller keeps a copy of these and of PROVIDER_QUOTA_EXHAUSTED_PATTERN
// (is_provider_rate_limited_failure in packages/runtime-controller/src/agent.rs)
// to label a failed run in the agent's history. Both are pinned to
// packages/runtime-controller/src/run_failure_fixtures.json, so edit them
// together.
const PROVIDER_RATE_LIMITED_PATTERNS = [
  /exceeded retry limit, last status:\s*429\b/i,
  /\bbackend responded with 429\b/i,
  /\bupstream_rate_limit\b/i,
  /upstream provider rate limit was reached/i,
];

// The provider stopped the answer early and Codex ended the turn with its own
// message: "Incomplete response returned, reason: <reason>". The Instafy proxy
// completes such a response with a notice instead, so this covers one that
// reached Codex any other way.
const RESPONSE_INCOMPLETE_PATTERN = /incomplete response returned, reason:\s*([a-z_]*)/i;

const INCOMPLETE_RESPONSE_FRIENDLY_TEXT: Record<string, string> = {
  max_output_tokens:
    "The answer hit the model's length limit before it was finished, so this turn stopped. Try asking for less at once, or in smaller steps.",
  content_filter:
    "The AI's content filter stopped this answer before it was finished, so this turn stopped. Try asking in different words.",
};

function incompleteResponseFriendlyText(rawText: string): string {
  const reason = RESPONSE_INCOMPLETE_PATTERN.exec(rawText)?.[1]?.toLowerCase() ?? "";
  return INCOMPLETE_RESPONSE_FRIENDLY_TEXT[reason] ?? RUN_FAILURE_FRIENDLY_TEXT.response_incomplete;
}

// The controller gave up on a turn a stop put back in the queue: no machine
// picked it up again before its resumeBy. Its message names the stop's reason
// (`interruptionReason`), so a turn someone stopped on purpose is not told it
// lost its machine.
const INTERRUPTED_RUN_EXPIRED_KIND = "interrupted_run_expired";
const STOPPED_RUN_EXPIRED_FRIENDLY_TEXT =
  "This turn was stopped and didn't pick up again in time. Try again to continue.";

function interruptedRunExpiredFriendlyText(metadata: Record<string, unknown> | null): string {
  return isPersonRuntimeStopReason(normalizedStringField(metadata, "interruptionReason"))
    ? STOPPED_RUN_EXPIRED_FRIENDLY_TEXT
    : RUN_FAILURE_FRIENDLY_TEXT.interrupted_run_expired;
}

// A spent usage window of the provider account: Codex's own text for a ChatGPT
// plan's limit ("You've hit your usage limit. Try again at <time>.", with a
// straight or a curly apostrophe) and the provider's code for it. It will not
// clear after a short wait, so it is never retried, and whose account it is
// decides the copy: Instafy AI's is not the person's to fix.
const PROVIDER_USAGE_LIMIT_PATTERNS = [/hit your usage limit/i, /\busage_limit_reached\b/i];
// The time the provider names for the window to reopen.
const USAGE_LIMIT_RESET_PATTERN = /try again at\s+([^\n]+?)\.?\s*$/im;

const MANAGED_AI_USAGE_LIMIT_FRIENDLY_TEXT =
  "Instafy AI is unavailable right now: it has reached its usage limit, so this turn stopped. This is on Instafy's side, not your credits or your plan. Try again later.";

function providerUsageLimitFriendlyText(
  rawText: string,
  metadata: Record<string, unknown> | null,
): string {
  const accessMode = normalizedStringField(metadata, "aiAccessMode");
  if (accessMode === "managed") {
    return MANAGED_AI_USAGE_LIMIT_FRIENDLY_TEXT;
  }
  if (accessMode !== "byoc") {
    return RUN_FAILURE_FRIENDLY_TEXT.provider_usage_limit;
  }
  const resetsAt = USAGE_LIMIT_RESET_PATTERN.exec(rawText)?.[1]?.trim() ?? "";
  return resetsAt
    ? `Your AI account has reached its usage limit, so this turn stopped. Try again at ${resetsAt}, or connect another AI.`
    : "Your AI account has reached its usage limit, so this turn stopped. Try again after it resets, or connect another AI.";
}

// A 429 that names an exhausted quota or plan limit will not clear after a
// short wait, so it keeps its raw reason instead of the rate limit copy.
const PROVIDER_QUOTA_EXHAUSTED_PATTERN =
  /insufficient_quota|quota_exceeded|usage_limit_reached|usage_not_included|\bquota\b/i;

/**
 * Failure kinds that may be re-dispatched automatically, once per originating
 * prompt. All are transient:
 * - `missing_final_message` is a provider hiccup that usually resolves on a
 *   fresh attempt. It resends at once.
 * - `provider_rate_limited` resends only after a visible countdown, and only
 *   when the failure itself says the limit is short (see
 *   {@link resolveRunFailureAutoRetryDelayMs}). Codex already retries a
 *   retryable 429 inside the turn, so this card means those retries ran out;
 *   an immediate resend would land in the same provider window, but one more
 *   attempt after a pause usually gets through. The person can cancel the
 *   countdown and keep the manual "Try again".
 *
 * `missing_verification` and `generic` are excluded because retrying rarely
 * helps and/or the underlying cause is deterministic. `no_workspace_changes`
 * is excluded because the runtime already gave the turn a second try inside
 * it, and the model answered both times: a resend would charge the person for
 * a third full turn they did not ask for, so "Try again" is theirs to press.
 * `needs_ai` needs a credential, not a retry. A 429 that names an exhausted
 * quota or plan limit never classifies as `provider_rate_limited` (it stays
 * `generic`), and a
 * spent usage window is `provider_usage_limit`, which waits hours or days, so
 * it is neither retried automatically nor offered a manual "Try again".
 * `response_incomplete` is excluded because the provider already billed the
 * cut-short answer, and the same request would most likely stop the same way.
 * `browser_page_missing` is excluded because the person has to open a page or
 * resend from Chat first; the manual "Try again" resends through the current
 * routing, which keeps a browser task unsent without a targeted page, and the
 * controller refuses one whose page is not open before anything runs.
 * `interrupted_run_expired` is excluded because the turn may have been
 * stopped on purpose, and a resend would ask for a machine again.
 * `ai_unavailable` is excluded because the AI service refused or dropped the
 * request: sent again at once it would most likely fail the same way, so the
 * person decides when to press "Try again".
 */
export const AUTO_RETRY_ELIGIBLE_KINDS = [
  "missing_final_message",
  "provider_rate_limited",
] as const satisfies readonly RunFailureKind[];

/** Maximum automatic re-dispatches allowed for a single originating prompt. */
export const MAX_AUTO_RETRIES_PER_ORIGIN = 1;

/**
 * Countdown before a rate-limited run is sent again when the failure is marked
 * retryable but names no wait.
 */
export const RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS = 20_000;
/** Longest countdown before a rate-limited run is sent again automatically. */
export const RATE_LIMIT_AUTO_RETRY_MAX_DELAY_MS = 60_000;
/**
 * Shortest countdown, so a failure that asks for a one second wait still shows
 * a readable countdown with time to press Cancel.
 */
export const RATE_LIMIT_AUTO_RETRY_MIN_DELAY_MS = 5_000;

export function isAutoRetryEligibleFailureKind(kind: RunFailureKind | null | undefined): boolean {
  return kind != null && (AUTO_RETRY_ELIGIBLE_KINDS as readonly string[]).includes(kind);
}

// The wait a rate limit names in its own text: the Instafy proxy ends a
// streamed 429 with "Please try again in 5.5s.", and providers word theirs the
// same way.
const RETRY_AFTER_TEXT_PATTERN =
  /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i;

// The proxy's answer for a rate limit window that reopens in more than a few
// minutes: still a rate limit, but marked not retryable, because any resend
// soon would land in the same exhausted window.
const NOT_RETRYABLE_PATTERN = /"retryable"\s*:\s*false\b/i;
// The proxy's error body for a short rate limit that is worth retrying.
const RETRYABLE_PATTERN = /"retryable"\s*:\s*true\b/i;

/**
 * The wait, in milliseconds, that a failure's raw text asks for before a
 * retry, or null when it names none.
 */
export function parseRunFailureRetryAfterMs(rawText: string): number | null {
  const match = RETRY_AFTER_TEXT_PATTERN.exec(rawText);
  if (!match) {
    return null;
  }
  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const unit = (match[2] ?? "").toLowerCase();
  return Math.ceil(unit.startsWith("m") ? amount : amount * 1000);
}

/**
 * The places a user message keeps the metadata its sender attached: the top
 * level while it is a local optimistic message (and for record-only sends),
 * and `prompt_metadata` once the controller stored a dispatched prompt.
 */
function promptMetadataRecords(metadata: unknown): Record<string, unknown>[] {
  if (!isRecord(metadata)) {
    return [];
  }
  const records = [metadata];
  for (const key of ["prompt_metadata", "promptMetadata"]) {
    const nested = metadata[key];
    if (isRecord(nested)) {
      records.push(nested);
    }
  }
  return records;
}

function hasBrowserRouting(record: Record<string, unknown>): boolean {
  const transport = record["browserTransport"];
  if (typeof transport === "string" && transport.trim().length > 0) {
    return true;
  }
  const pageId = record["browserPageId"];
  if (typeof pageId === "string" && pageId.trim().length > 0) {
    return true;
  }
  const expectations = record["runtimeExpectations"];
  return isRecord(expectations) && expectations["browserExecution"] === true;
}

/**
 * True when a prompt was routed to a browser page (the shared browser or the
 * desktop personal browser). Sending such a turn again on its own can repeat
 * whatever the first attempt already did in that page, so it is never
 * re-dispatched without the person asking.
 */
export function isBrowserRoutedPromptMetadata(metadata: unknown): boolean {
  return promptMetadataRecords(metadata).some(hasBrowserRouting);
}

function hasAttachments(record: Record<string, unknown>): boolean {
  const attachments = record["attachments"];
  return Array.isArray(attachments) && attachments.length > 0;
}

function hasReplyContext(record: Record<string, unknown>): boolean {
  return isRecord(record["replyContext"]) || isRecord(record["reply_context"]);
}

// A hand-back names the browser turn whose findings it carries: the claim
// Studio sends (`continuesFromBrowserJob`) or the controller's record
// (`browserHandBack`).
function hasBrowserHandBack(record: Record<string, unknown>): boolean {
  return record["continuesFromBrowserJob"] != null || record["browserHandBack"] != null;
}

// A prompt that acts on another message, such as an undo request
// (`undoTargetMessageId`), names it in a `...TargetMessageId` field.
function hasMessageTarget(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(
    ([key, value]) =>
      /targetmessageid$/i.test(key) && typeof value === "string" && value.trim().length > 0,
  );
}

/**
 * True when an automatic resend of this prompt would be the same request it
 * was. An automatic resend carries only the prompt's text: no attachments, no
 * reply context and no browser targeting. So it is not made for:
 * - a prompt that carried attachments (`attachments`, such as uploaded
 *   images), which the resend would drop;
 * - a prompt that replied to a selected part of an earlier message
 *   (`replyContext`), which the resend would drop;
 * - a prompt that acts on another message (`undoTargetMessageId` and other
 *   `...TargetMessageId` fields), which the resend would drop, and which can
 *   be destructive, such as an undo;
 * - a prompt routed to a browser page ({@link isBrowserRoutedPromptMetadata});
 * - a hand-back (`continuesFromBrowserJob`), whose words alone would go out
 *   as a turn of their own, without what the browser found, and be charged;
 * - a prompt dispatched with other text than it shows (`dispatchContent`),
 *   which is how a targeted or fresh browser page and a goal command wrap the
 *   typed text.
 */
export function isRunFailurePromptAutoResendable(
  promptMessage: Pick<ChatMessage, "content" | "metadata">,
): boolean {
  const records = promptMetadataRecords(promptMessage.metadata);
  if (records.some(
      (record) =>
        hasBrowserRouting(record) ||
        hasBrowserHandBack(record) ||
        hasAttachments(record) ||
        hasReplyContext(record) ||
        hasMessageTarget(record),
    )) {
    return false;
  }
  const shownText = promptMessage.content.trim();
  return !records.some((record) => {
    const dispatchContent = record["dispatchContent"];
    return (
      typeof dispatchContent === "string" &&
      dispatchContent.trim().length > 0 &&
      dispatchContent.trim() !== shownText
    );
  });
}

function trimmedStringField(record: Record<string, unknown> | null, keys: string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

/**
 * True when this browser tab sent the prompt: the signed-in person wrote it,
 * and the client session stored with it is this tab's. Only that tab resends
 * a failed run automatically. Everyone else who has the conversation open
 * (the same person in another tab or on another device, or the other people
 * in a group conversation) gets the manual card, so a failure is never resent
 * twice or under someone else's name. A prompt that names no client session,
 * such as one the controller dispatched from its send queue, stays manual.
 */
export function isRunFailurePromptFromThisClient(params: {
  promptMessage: Pick<ChatMessage, "authorId" | "metadata">;
  currentUserId: string | null | undefined;
  chatClientSessionId: string | null | undefined;
}): boolean {
  const currentUserId = params.currentUserId?.trim() ?? "";
  const chatClientSessionId = params.chatClientSessionId?.trim() ?? "";
  if (!currentUserId || !chatClientSessionId) {
    return false;
  }
  const client =
    promptMetadataRecords(params.promptMessage.metadata)
      .map((record) => record["client"])
      .find(isRecord) ?? null;
  if (trimmedStringField(client, ["sessionId", "session_id"]) !== chatClientSessionId) {
    return false;
  }
  const authorId =
    typeof params.promptMessage.authorId === "string" ? params.promptMessage.authorId.trim() : "";
  return (authorId || trimmedStringField(client, ["userId", "user_id"])) === currentUserId;
}

/**
 * How long to wait before automatically sending a failed run's prompt again:
 * 0 to resend at once, a positive delay to resend after a visible countdown,
 * or null when this failure must stay manual.
 *
 * Every kind stays manual when the resend would not be the same request
 * ({@link isRunFailurePromptAutoResendable}), and when the prompt was itself
 * a retry of an earlier failure ({@link readRunFailureRetryOf}), so a retry
 * never retries itself.
 *
 * A rate limit counts down only when the failure says the limit is short: it
 * names its wait (the proxy's streamed "Please try again in 5.5s.") or the
 * proxy marked it retryable. The wait it names (or
 * {@link RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS}) is bounded to
 * {@link RATE_LIMIT_AUTO_RETRY_MIN_DELAY_MS}..{@link RATE_LIMIT_AUTO_RETRY_MAX_DELAY_MS}.
 * Codex's bare "exceeded retry limit, last status: 429 Too Many Requests"
 * stays manual: a spent ChatGPT plan window arrives with that same text, and
 * a usage limit must never be retried automatically. A rate limit the proxy
 * marked not retryable (a window that reopens much later) stays manual too.
 */
export function resolveRunFailureAutoRetryDelayMs(params: {
  presentation: Pick<RunFailurePresentation, "kind" | "rawText">;
  promptMessage?: Pick<ChatMessage, "content" | "metadata"> | null;
}): number | null {
  const { presentation, promptMessage } = params;
  if (!isAutoRetryEligibleFailureKind(presentation.kind)) {
    return null;
  }
  if (
    promptMessage &&
    (!isRunFailurePromptAutoResendable(promptMessage) || readRunFailureRetryOf(promptMessage) !== null)
  ) {
    return null;
  }
  if (presentation.kind !== "provider_rate_limited") {
    return 0;
  }
  if (NOT_RETRYABLE_PATTERN.test(presentation.rawText)) {
    return null;
  }
  const namedWait = parseRunFailureRetryAfterMs(presentation.rawText);
  if (namedWait === null && !RETRYABLE_PATTERN.test(presentation.rawText)) {
    return null;
  }
  const requested = namedWait ?? RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS;
  return Math.min(
    RATE_LIMIT_AUTO_RETRY_MAX_DELAY_MS,
    Math.max(RATE_LIMIT_AUTO_RETRY_MIN_DELAY_MS, requested),
  );
}

/**
 * How old a failure may be, by its own timestamp, and still be sent again
 * automatically.
 */
export const RUN_FAILURE_AUTO_RETRY_MAX_AGE_MS = 10 * 60_000;

/**
 * True when the failure happened within {@link RUN_FAILURE_AUTO_RETRY_MAX_AGE_MS}
 * of `now`, on either side to allow for a skewed clock. A failure without a
 * usable timestamp is never sent again automatically.
 */
export function isRunFailureRecentForAutoRetry(
  failureMessage: Pick<ChatMessage, "timestamp">,
  now: number = Date.now(),
): boolean {
  const timestamp = failureMessage.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return false;
  }
  return Math.abs(now - timestamp) <= RUN_FAILURE_AUTO_RETRY_MAX_AGE_MS;
}

const SUCCEEDED_RUN_OUTCOMES = new Set(["succeeded", "success", "completed", "done"]);

function normalizedAgentHandle(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^@+/, "").trim().toLowerCase() : "";
}

function messageAgentHandle(message: ChatMessage): string {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const direct = normalizedAgentHandle(metadata?.["agentHandle"] ?? metadata?.["agent_handle"]);
  if (direct) {
    return direct;
  }
  const agent = metadata && isRecord(metadata["agent"]) ? metadata["agent"] : null;
  return normalizedAgentHandle(agent?.["handle"]);
}

function messageRunId(message: ChatMessage): string {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  for (const key of ["jobId", "job_id", "runId", "run_id"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

/** The agents a prompt was sent to, as its stored agent selection names them. */
function promptTargetAgentHandles(promptMessage: Pick<ChatMessage, "metadata">): Set<string> {
  const handles = new Set<string>();
  for (const record of promptMetadataRecords(promptMessage.metadata)) {
    const selection = record["agentSelection"];
    if (!isRecord(selection)) {
      continue;
    }
    const readHandles = (value: unknown) =>
      Array.isArray(value) ? value.map(normalizedAgentHandle).filter((handle) => handle.length > 0) : [];
    const mentions = readHandles(selection["mentions"]);
    // The same rule the submit path uses: mentioned agents, else every active one.
    for (const handle of mentions.length > 0 ? mentions : readHandles(selection["active"])) {
      handles.add(handle);
    }
  }
  return handles;
}

/**
 * True when the prompt behind a failed run went to more than one agent, or
 * another run for the same prompt succeeded. An automatic resend sends the
 * whole prompt to every agent again, so it would repeat the work of the run
 * that went well. Read from the prompt's stored agent selection and from the
 * replies between the prompt and the next user message.
 */
export function isRunFailurePromptSharedWithOtherRuns(params: {
  conversationMessages: ChatMessage[];
  promptMessage: ChatMessage;
  failureMessage: ChatMessage;
}): boolean {
  const { conversationMessages, promptMessage, failureMessage } = params;
  if (promptTargetAgentHandles(promptMessage).size > 1) {
    return true;
  }
  const promptIndex = conversationMessages.findIndex((message) => message.id === promptMessage.id);
  if (promptIndex < 0) {
    return false;
  }
  const failureHandle = messageAgentHandle(failureMessage);
  const failureRunId = messageRunId(failureMessage);
  const handles = new Set<string>(failureHandle ? [failureHandle] : []);
  for (let index = promptIndex + 1; index < conversationMessages.length; index += 1) {
    const message = conversationMessages[index];
    if (message.role === "user") {
      break;
    }
    if (message.id === failureMessage.id) {
      continue;
    }
    const handle = messageAgentHandle(message);
    if (handle) {
      handles.add(handle);
    }
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    if (!SUCCEEDED_RUN_OUTCOMES.has(normalizedStringField(metadata, "outcome"))) {
      continue;
    }
    const runId = messageRunId(message);
    const otherRun = Boolean(runId && failureRunId && runId !== failureRunId);
    const otherAgent = Boolean(handle && failureHandle && handle !== failureHandle);
    if (otherRun || otherAgent) {
      return true;
    }
  }
  return handles.size > 1;
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
  if (BROWSER_PAGE_MISSING_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return "browser_page_missing";
  }
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
  if (RESPONSE_INCOMPLETE_PATTERN.test(rawText)) {
    return "response_incomplete";
  }
  if (PROVIDER_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return "provider_usage_limit";
  }
  if (
    PROVIDER_RATE_LIMITED_PATTERNS.some((pattern) => pattern.test(rawText)) &&
    !PROVIDER_QUOTA_EXHAUSTED_PATTERN.test(rawText)
  ) {
    return "provider_rate_limited";
  }
  return null;
}

// The address Codex adds to a proxy diagnostic (", url: http://proxy:8789/v1/responses"):
// the Instafy proxy's own address inside the machine, which tells the person nothing.
const PROXY_DIAGNOSTIC_ADDRESS = /,\s*url:\s*[^\s,]+/giu;

/**
 * A run the AI service refused or never answered: the Instafy proxy's
 * "unexpected status …" diagnostic, read by proxyError. On Instafy AI the
 * person has nothing to fix, so it names no sign-in or account. On their own
 * AI it says what to do, in plain words, with "Manage AI" when settings can
 * fix it. Every proxy failure keeps "Try again", and its Details keep the
 * status and what the service said, without the proxy's address.
 */
function aiUnavailablePresentation(
  rawText: string,
  metadata: Record<string, unknown> | null,
): RunFailurePresentation | null {
  const guidance = resolveProxyUpstreamErrorGuidance(rawText);
  if (!guidance) {
    return null;
  }
  const details = rawText.replace(PROXY_DIAGNOSTIC_ADDRESS, "").trim() || rawText;
  if (normalizedStringField(metadata, "aiAccessMode") === "managed") {
    return { kind: "ai_unavailable", friendlyText: RUN_FAILURE_FRIENDLY_TEXT.ai_unavailable, rawText: details };
  }
  return {
    kind: "ai_unavailable",
    friendlyText: guidance.summary,
    rawText: details,
    manageAi: guidance.actionKind === "open_ai_settings",
  };
}

/**
 * Resolve the friendly presentation for a failed-run message body.
 *
 * Returns null when the message should keep its current rendering (unknown
 * text without failed-run metadata, or empty content).
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
  const classified = classifyRunFailureText(rawText);
  if (normalizedStringField(metadata, "kind") !== INTERRUPTED_RUN_EXPIRED_KIND) {
    // A proxy diagnostic reads as the AI not answering, unless it is a spent
    // usage window, whose copy says when it reopens and offers no resend.
    const aiUnavailable =
      classified === "provider_usage_limit" ? null : aiUnavailablePresentation(rawText, metadata);
    if (aiUnavailable) {
      return aiUnavailable;
    }
  }
  const kind =
    normalizedStringField(metadata, "kind") === INTERRUPTED_RUN_EXPIRED_KIND
      ? INTERRUPTED_RUN_EXPIRED_KIND
      : classified ?? (failedByMetadata ? "generic" : null);
  if (!kind) {
    return null;
  }
  return { kind, friendlyText: runFailureFriendlyText(kind, rawText, metadata), rawText };
}

function runFailureFriendlyText(
  kind: RunFailureKind,
  rawText: string,
  metadata: Record<string, unknown> | null,
): string {
  switch (kind) {
    case "generic":
      return inlineGenericFailureText(rawText);
    case "no_workspace_changes":
      return noChangesFriendlyText(metadata);
    case "response_incomplete":
      return incompleteResponseFriendlyText(rawText);
    case "provider_usage_limit":
      return providerUsageLimitFriendlyText(rawText, metadata);
    case INTERRUPTED_RUN_EXPIRED_KIND:
      return interruptedRunExpiredFriendlyText(metadata);
    default:
      return RUN_FAILURE_FRIENDLY_TEXT[kind];
  }
}

export type RetryingStatusPresentation = {
  displayText: string;
  fullText: string;
};

// Status kinds the runtime agent writes while Codex retries: a re-dispatched
// run, and a recovered stream error such as a rate-limited request.
const RETRYING_STATUS_KINDS = new Set(["codex_retry", "codex_stream_retry"]);

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
  // The controller stores a runtime update under `details` and writes its own
  // `kind` ("update") on top, so the retry kind can sit one level down.
  const details = metadata && isRecord(metadata["details"]) ? metadata["details"] : null;
  if (
    RETRYING_STATUS_KINDS.has(normalizedStringField(metadata, "kind")) ||
    RETRYING_STATUS_KINDS.has(normalizedStringField(details, "kind"))
  ) {
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

type RunFailureMessageRef = Pick<ChatMessage, "id" | "timestamp"> &
  Partial<Pick<ChatMessage, "metadata">>;

function stringFields(metadata: unknown, keys: readonly string[]): string[] {
  if (!isRecord(metadata)) {
    return [];
  }
  const values = new Set<string>();
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.add(value.trim());
    }
  }
  return [...values];
}

/**
 * The run and job ids a failed run's message names: the controller stores the
 * job id in its metadata and the run id on its row.
 */
export function readRunFailureRunIds(failureMessage: Partial<Pick<ChatMessage, "metadata">>): string[] {
  return stringFields(failureMessage.metadata, ["jobId", "job_id", "runId", "run_id"]);
}

/**
 * The run a prompt started, as its stored copy names it: the controller stores
 * the run a dispatched prompt started on the prompt's row. A local copy, and a
 * prompt that was only recorded, name none.
 */
function readPromptRunIds(promptMessage: Pick<ChatMessage, "metadata">): string[] {
  return stringFields(promptMessage.metadata, ["runId", "run_id"]);
}

/**
 * Where a failure message sits in the conversation: its own index when it is
 * stored there, otherwise (synthesized terminal messages from run records are
 * not stored in the conversation) the index where it would sort by timestamp.
 * `after` is the index of the first message that came after the failure; a
 * failure that cannot be placed at all has nothing after it.
 */
function locateRunFailureMessage(
  conversationMessages: ChatMessage[],
  failureMessage: RunFailureMessageRef,
): { before: number; after: number } {
  const index = conversationMessages.findIndex((message) => message.id === failureMessage.id);
  if (index >= 0) {
    return { before: index, after: index + 1 };
  }
  let searchFrom = conversationMessages.length;
  const failureTimestamp =
    typeof failureMessage.timestamp === "number" && Number.isFinite(failureMessage.timestamp)
      ? failureMessage.timestamp
      : null;
  if (failureTimestamp === null) {
    return { before: searchFrom, after: searchFrom };
  }
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
  return { before: searchFrom, after: searchFrom };
}

/**
 * A steer: a message the person sent into a run that was already going. The
 * controller stores it with that run's id, so it names the run without
 * having started it.
 */
function readSteerSendIntent(message: Pick<ChatMessage, "metadata">): Record<string, unknown> | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const sendIntent = metadata && isRecord(metadata["sendIntent"]) ? metadata["sendIntent"] : null;
  return normalizedStringField(sendIntent, "mode") === "steer" ? sendIntent : null;
}

/**
 * The user message that started a failed run. That is the first prompt whose
 * stored copy names the failed run, so a note someone wrote while the run was
 * going (which group participation only recorded) or a steer sent into the
 * run is not taken for it. When no prompt names the run (its stored copy has
 * not arrived yet, or the failure names no run), it is the nearest user
 * message before the failure that is not a steer.
 */
export function resolveRunFailureRetrySource(params: {
  conversationMessages: ChatMessage[];
  failureMessage: RunFailureMessageRef;
}): ChatMessage | null {
  const { conversationMessages, failureMessage } = params;
  const { before } = locateRunFailureMessage(conversationMessages, failureMessage);
  const end = Math.min(before, conversationMessages.length);
  const isPrompt = (candidate: ChatMessage) =>
    candidate.role === "user" &&
    candidate.content.trim().length > 0 &&
    readSteerSendIntent(candidate) === null;
  const failureRunIds = new Set(readRunFailureRunIds(failureMessage));
  if (failureRunIds.size > 0) {
    for (let index = 0; index < end; index += 1) {
      const candidate = conversationMessages[index];
      if (isPrompt(candidate) && readPromptRunIds(candidate).some((id) => failureRunIds.has(id))) {
        return candidate;
      }
    }
  }
  for (let index = end - 1; index >= 0; index -= 1) {
    const candidate = conversationMessages[index];
    if (isPrompt(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * True when someone steered the failed run: a message sent into it while it
 * was going names its run or job. Resending the prompt that started the run
 * would drop what the steer asked for.
 */
export function isRunFailureRunSteered(params: {
  conversationMessages: ChatMessage[];
  failureMessage: RunFailureMessageRef;
}): boolean {
  const failureRunIds = new Set(readRunFailureRunIds(params.failureMessage));
  if (failureRunIds.size === 0) {
    return false;
  }
  return params.conversationMessages.some((message) => {
    const sendIntent = message.role === "user" ? readSteerSendIntent(message) : null;
    return (
      sendIntent !== null &&
      [...readPromptRunIds(message), ...stringFields(sendIntent, ["jobId", "job_id"])].some((id) =>
        failureRunIds.has(id),
      )
    );
  });
}

/**
 * Resolve the prompt text to re-submit for a failed run: the content of
 * {@link resolveRunFailureRetrySource}.
 */
export function resolveRunFailureRetryPrompt(params: {
  conversationMessages: ChatMessage[];
  failureMessage: RunFailureMessageRef;
}): string | null {
  return resolveRunFailureRetrySource(params)?.content ?? null;
}

/**
 * Metadata key on a resent prompt that names the failed message it retries.
 * The message-create path passes metadata to the controller verbatim, so the
 * link survives a reload.
 */
export const RUN_FAILURE_RETRY_OF_METADATA_KEY = "retryOfMessageId";

/**
 * Metadata key on a resend Instafy made by itself (the automatic retry), not
 * one the person asked for with "Try again". Billing reads it (as checked by
 * the controller): such a turn costs nothing unless it leaves the person
 * something. The chat folds every resend alike (automaticRetryFold).
 */
export const RUN_FAILURE_RETRY_AUTOMATIC_METADATA_KEY = "retryAutomatic";

export function buildRunFailureRetryMetadata(
  failureMessage: Pick<ChatMessage, "id">,
  { automatic = false }: { automatic?: boolean } = {},
): Record<string, unknown> {
  return automatic
    ? { [RUN_FAILURE_RETRY_OF_METADATA_KEY]: failureMessage.id, [RUN_FAILURE_RETRY_AUTOMATIC_METADATA_KEY]: true }
    : { [RUN_FAILURE_RETRY_OF_METADATA_KEY]: failureMessage.id };
}

/** The id of the failed message a prompt was sent to retry, or null. */
export function readRunFailureRetryOf(message: Pick<ChatMessage, "metadata">): string | null {
  for (const record of promptMetadataRecords(message.metadata)) {
    const value = record[RUN_FAILURE_RETRY_OF_METADATA_KEY];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * True when a send still waiting in a send queue retries this failure: the
 * local queue (kept in localStorage) and the controller queue both keep the
 * metadata the resend was queued with, so this also holds after a reload.
 */
export function isRunFailureRetryQueued(params: {
  queuedSends: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>;
  failureMessage: Pick<ChatMessage, "id">;
}): boolean {
  return params.queuedSends.some(
    (item) => readRunFailureRetryOf({ metadata: item.metadata ?? null }) === params.failureMessage.id,
  );
}

/**
 * True once the failed run's prompt has been sent again, so its card must not
 * offer another "Try again". Two signals, both read from stored messages:
 * - a user message whose metadata names this failure
 *   ({@link RUN_FAILURE_RETRY_OF_METADATA_KEY}), written by every retry and
 *   kept under `prompt_metadata` once the controller stored the prompt;
 * - for retries sent before that link existed, or a prompt the person pasted
 *   again by hand, a user message after the failure with the same text as
 *   the prompt that started it.
 *
 * `isUnsent` names user messages that never went out (their dispatch
 * failed), which count as neither.
 */
export function isRunFailureRetrySuperseded(params: {
  conversationMessages: ChatMessage[];
  failureMessage: RunFailureMessageRef;
  isUnsent?: (message: ChatMessage) => boolean;
}): boolean {
  const { conversationMessages, failureMessage, isUnsent } = params;
  const isSentPrompt = (message: ChatMessage) =>
    message.role === "user" && !(isUnsent?.(message) ?? false);
  const linked = conversationMessages.some(
    (message) =>
      isSentPrompt(message) &&
      promptMetadataRecords(message.metadata).some(
        (record) => record[RUN_FAILURE_RETRY_OF_METADATA_KEY] === failureMessage.id,
      ),
  );
  if (linked) {
    return true;
  }
  const source = resolveRunFailureRetrySource(params);
  const originKey = source ? runFailureOriginKey(source.content) : "";
  if (!originKey) {
    return false;
  }
  const { after } = locateRunFailureMessage(conversationMessages, failureMessage);
  for (let index = after; index < conversationMessages.length; index += 1) {
    const candidate = conversationMessages[index];
    if (isSentPrompt(candidate) && runFailureOriginKey(candidate.content) === originKey) {
      return true;
    }
  }
  return false;
}
