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
  | "response_incomplete"
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
  // The proxy reports a spent ChatGPT plan window with the same 429 text as a
  // short throttle, so this copy cannot promise when a retry will work.
  provider_rate_limited:
    "The AI provider is limiting requests right now, so this turn stopped. Wait a little, then try again. If it keeps happening, the provider account may have reached its usage limit.",
  // Used when the provider gave a reason this copy does not name; see
  // INCOMPLETE_RESPONSE_FRIENDLY_TEXT for the ones it does.
  response_incomplete:
    "The AI provider stopped the answer before it was finished, so this turn stopped. Try again, or ask for less at once.",
  // Only used as a last-resort fallback now: an unclassified failure surfaces
  // its real reason inline (see inlineGenericFailureText) rather than this
  // uninformative sentence.
  generic: "Something went wrong finishing this run.",
};

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
  if (!firstLine) {
    return RUN_FAILURE_FRIENDLY_TEXT.generic;
  }
  if (firstLine.length <= GENERIC_INLINE_FAILURE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, GENERIC_INLINE_FAILURE_MAX_LENGTH - 1).trimEnd()}…`;
}

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

// The model provider answered 429 and the run stopped. Codex reports it as
// "exceeded retry limit, last status: 429 Too Many Requests" even though no
// retry happened, and the Instafy proxy labels it upstream_rate_limit. Proxy
// errors that still read "unexpected status 429" keep their curated guidance,
// because callers check for that before classifying the failure here.
// A bare "429 Too Many Requests" is not enough: a throttled skill import or the
// scoped worker proxy fail with that same phrase, and neither is the AI
// provider.
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
    "The answer hit the model's length limit before it was finished, so this turn stopped. Try asking for less at once, or split the request into smaller steps.",
  content_filter:
    "The AI provider's content filter stopped this answer before it was finished, so this turn stopped. Try rephrasing the request.",
};

function incompleteResponseFriendlyText(rawText: string): string {
  const reason = RESPONSE_INCOMPLETE_PATTERN.exec(rawText)?.[1]?.toLowerCase() ?? "";
  return INCOMPLETE_RESPONSE_FRIENDLY_TEXT[reason] ?? RUN_FAILURE_FRIENDLY_TEXT.response_incomplete;
}

// A 429 that names an exhausted quota or plan limit will not clear after a
// short wait, so it keeps its raw reason instead of the rate limit copy.
const PROVIDER_QUOTA_EXHAUSTED_PATTERN =
  /insufficient_quota|quota_exceeded|usage_limit_reached|usage_not_included|\bquota\b/i;

/**
 * Failure kinds that may be re-dispatched automatically, once per originating
 * prompt. All are transient:
 * - `missing_final_message` is a provider hiccup that usually resolves on a
 *   fresh attempt, and `no_workspace_changes` is a reply that dropped its file
 *   writes. Both resend at once.
 * - `provider_rate_limited` resends only after a visible countdown, and only
 *   when the failure itself says the limit is short (see
 *   {@link resolveRunFailureAutoRetryDelayMs}). Codex already retries a
 *   retryable 429 inside the turn, so this card means those retries ran out;
 *   an immediate resend would land in the same provider window, but one more
 *   attempt after a pause usually gets through. The person can cancel the
 *   countdown and keep the manual "Try again".
 *
 * `missing_verification` and `generic` are excluded because retrying rarely
 * helps and/or the underlying cause is deterministic. `needs_ai` needs a
 * credential, not a retry. A 429 that names an exhausted quota or plan limit
 * never classifies as `provider_rate_limited` (it stays `generic`).
 * `response_incomplete` is excluded because the provider already billed the
 * cut-short answer, and the same request would most likely stop the same way.
 */
export const AUTO_RETRY_ELIGIBLE_KINDS = [
  "missing_final_message",
  "no_workspace_changes",
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
  if (
    PROVIDER_RATE_LIMITED_PATTERNS.some((pattern) => pattern.test(rawText)) &&
    !PROVIDER_QUOTA_EXHAUSTED_PATTERN.test(rawText)
  ) {
    return "provider_rate_limited";
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
  const friendlyText =
    kind === "generic"
      ? inlineGenericFailureText(rawText)
      : kind === "response_incomplete"
        ? incompleteResponseFriendlyText(rawText)
        : RUN_FAILURE_FRIENDLY_TEXT[kind];
  return { kind, friendlyText, rawText };
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
  const kind = normalizedStringField(metadata, "kind");
  if (RETRYING_STATUS_KINDS.has(kind)) {
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

export function buildRunFailureRetryMetadata(
  failureMessage: Pick<ChatMessage, "id">,
): Record<string, unknown> {
  return { [RUN_FAILURE_RETRY_OF_METADATA_KEY]: failureMessage.id };
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
