import type { ChatMessage } from "../screens/studio/types";
import { readRunFailureRetryOf } from "./runFailurePresentation";

/**
 * The prompts this page sent, and the runs each one started, held in module
 * memory only.
 *
 * A failed run is sent again automatically only when this page instance sent
 * the prompt that started that run (see useRunFailureAutoRetry). Nothing here
 * is persisted: a reload, a duplicated browser tab (which copies
 * sessionStorage, and with it the chat client session id) and every other
 * device start with an empty registry, so none of them can resend a prompt
 * they did not send themselves.
 *
 * A prompt is known by its message id and by the `clientMessageId` it was
 * sent with. The id changes once the controller stores the prompt, but the
 * stored copy keeps the `clientMessageId` (under `prompt_metadata`). The runs
 * are the run and job ids the controller returned when it dispatched the
 * prompt; a prompt that was only recorded (group participation decided no
 * agent replies) or whose dispatch failed has none. A prompt whose dispatch
 * or recording failed is marked, so its local copy does not count as a
 * retry of a failed run.
 */
type SentPrompt = {
  /** Set once the prompt's single automatic retry has been used up. */
  autoRetryClaimed: boolean;
  /** Run and job ids the controller started for this prompt. */
  runIds: Set<string>;
  /** The failed message this prompt was sent to retry, if it was a retry. */
  retryOf: string | null;
  /** Set when the controller did not take the prompt (its dispatch or recording failed). */
  sendFailed: boolean;
};

/** What the registry reads from a prompt: its id, its metadata, or both. */
type PromptRef = { id?: string | null; metadata?: unknown };

// Each prompt takes up to three keys; old entries go first.
const MAX_KEYS = 600;

const sentPromptsByKey = new Map<string, SentPrompt>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientMessageIds(metadata: unknown): string[] {
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
  const ids = new Set<string>();
  for (const record of records) {
    for (const key of ["clientMessageId", "client_message_id"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        ids.add(value.trim());
      }
    }
  }
  return [...ids];
}

function keysFor(message: PromptRef): string[] {
  const keys = clientMessageIds(message.metadata).map((id) => `client:${id}`);
  const messageId = typeof message.id === "string" ? message.id.trim() : "";
  if (messageId) {
    keys.push(`message:${messageId}`);
  }
  return keys;
}

function findEntry(message: PromptRef): SentPrompt | null {
  for (const key of keysFor(message)) {
    const entry = sentPromptsByKey.get(key);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function normalizedIds(ids: readonly string[]): string[] {
  return ids.map((id) => (typeof id === "string" ? id.trim() : "")).filter((id) => id.length > 0);
}

/** Records a prompt this page is sending, by its message id and client message id. */
export function rememberPromptSentFromThisPage(message: Pick<ChatMessage, "id" | "metadata">): void {
  const keys = keysFor(message);
  if (keys.length === 0) {
    return;
  }
  const entry = findEntry(message) ?? {
    autoRetryClaimed: false,
    runIds: new Set<string>(),
    retryOf: readRunFailureRetryOf({ metadata: message.metadata }),
    sendFailed: false,
  };
  for (const key of keys) {
    sentPromptsByKey.delete(key);
    sentPromptsByKey.set(key, entry);
  }
  while (sentPromptsByKey.size > MAX_KEYS) {
    const oldest = sentPromptsByKey.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    sentPromptsByKey.delete(oldest);
  }
}

/**
 * Records the runs the controller started for a prompt this page sent: the
 * run and job ids its dispatch returned. A prompt this page did not record
 * with {@link rememberPromptSentFromThisPage} is ignored.
 */
export function recordRunsStartedByPromptSentFromThisPage(
  message: PromptRef,
  runIds: readonly string[],
): void {
  const entry = findEntry(message);
  if (!entry) {
    return;
  }
  for (const id of normalizedIds(runIds)) {
    entry.runIds.add(id);
  }
}

/**
 * True when this page instance sent the prompt (local copy or stored copy)
 * and that prompt started one of the given runs. A prompt that started no
 * run, such as a note group participation only recorded, never matches.
 */
export function wasRunStartedByPromptSentFromThisPage(
  message: Pick<ChatMessage, "id" | "metadata">,
  runIds: readonly string[],
): boolean {
  const entry = findEntry(message);
  return entry !== null && normalizedIds(runIds).some((id) => entry.runIds.has(id));
}

/**
 * Records that the controller did not take a prompt this page sent: its
 * dispatch failed, or recording it failed. A prompt this page did not record
 * with {@link rememberPromptSentFromThisPage} is ignored.
 */
export function recordSendFailedForPromptSentFromThisPage(message: PromptRef): void {
  const entry = findEntry(message);
  if (entry) {
    entry.sendFailed = true;
  }
}

// A prompt sent to several agent threads failed only when none of its
// dispatches started a run.
function didSendFail(entry: SentPrompt): boolean {
  return entry.sendFailed && entry.runIds.size === 0;
}

/**
 * True when this page sent the prompt (local copy or stored copy) and the
 * controller did not take it, so it never went out.
 */
export function didSendFailForPromptSentFromThisPage(message: PromptRef): boolean {
  const entry = findEntry(message);
  return entry !== null && didSendFail(entry);
}

/**
 * What became of the prompts this page sent to retry a failed message:
 * - `"started_run"`: one of them started a run;
 * - `"sent"`: the controller took one but started no run (group
 *   participation only recorded it);
 * - `"failed"`: the controller took none of them (dispatch or recording
 *   failed), so the prompt was never sent again;
 * - `null`: this page sent no retry of it.
 */
export type RetrySentFromThisPage = "started_run" | "sent" | "failed";

export function readRetrySentFromThisPage(failureMessageId: string): RetrySentFromThisPage | null {
  const failureId = failureMessageId.trim();
  if (!failureId) {
    return null;
  }
  let outcome: RetrySentFromThisPage | null = null;
  for (const entry of new Set(sentPromptsByKey.values())) {
    if (entry.retryOf !== failureId) {
      continue;
    }
    if (entry.runIds.size > 0) {
      return "started_run";
    }
    if (!didSendFail(entry)) {
      outcome = "sent";
    } else if (outcome === null) {
      outcome = "failed";
    }
  }
  return outcome;
}

/**
 * Uses up the one automatic retry of a prompt this page sent. Returns false
 * when the page did not send it, or when its retry was already used, also by
 * another chat panel of this page or before that panel was remounted.
 */
export function claimAutoRetryForPromptSentFromThisPage(
  message: Pick<ChatMessage, "id" | "metadata">,
): boolean {
  const entry = findEntry(message);
  if (!entry || entry.autoRetryClaimed) {
    return false;
  }
  entry.autoRetryClaimed = true;
  return true;
}

/** Empties the registry, as a reload would. Tests only. */
export function forgetPromptsSentFromThisPageForTests(): void {
  sentPromptsByKey.clear();
}
