import { useCallback, useRef } from "react";
import type { ChatMessage } from "../types";
import { readBrowserHandBackOf } from "./browserHandBack";
import {
  BROWSER_CONTINUES_RUN_METADATA_KEY,
  browserRequestFromMessage,
  browserRequestKey,
  readBrowserRequestOf,
} from "./browserRequest";
import { CONTINUED_STOP_METADATA_KEY, readChatRunStopNotice, readContinuedStop } from "./controllerConversationNotice";
import { readChangeUndone } from "./chatLaterChanges";
import type { QueuedChatSendItem } from "./chatSendQueueStorage";
import { isLetOctoContinuePrompt } from "./useBrowserHumanInput";
import type { SubmitMessageFn } from "./useChatSubmitFlow";

/**
 * How long after a browser turn its build can still be started from what it
 * found (runtime-controller `browser_hand_back::HAND_BACK_WINDOW_MINUTES`).
 */
const HAND_BACK_WINDOW_MS = 30 * 60_000;

type Options = {
  conversationId: string | null;
  viewerUserId: string | null;
  humanLabelByUserId: ReadonlyMap<string, string>;
  canWrite: boolean;
  busy: boolean;
  messages: readonly ChatMessage[];
  /** The chat has messages newer than `messages` holds (the ones around a searched message). */
  hasNewer: boolean;
  queuedSends: readonly QueuedChatSendItem[];
  submitMessage: SubmitMessageFn;
  /**
   * Sends a hand-back again, its claim on the browser turn and Studio's words,
   * with the given metadata (as Try again does); resolves to whether it went out.
   */
  resendHandBack?: (handBack: ChatMessage, metadata: Record<string, unknown>) => Promise<boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A prompt's own metadata and its stored prompt's, which a reload brings back. */
function promptRecords(message: Pick<ChatMessage, "metadata">): Record<string, unknown>[] {
  const metadata = message.metadata;
  if (!isRecord(metadata)) return [];
  return [metadata, metadata["prompt_metadata"], metadata["promptMetadata"]].filter(isRecord);
}

function promptString(message: Pick<ChatMessage, "metadata">, key: string): string | null {
  for (const record of promptRecords(message)) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function runOf(message: Pick<ChatMessage, "metadata">): string | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  for (const key of ["runId", "run_id"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** The runs an earlier press of Continue carried on. */
function continuedRunsOf(message: Pick<ChatMessage, "metadata">): string[] {
  for (const record of promptRecords(message)) {
    const runs = record["continuedRunIds"];
    if (!Array.isArray(runs)) continue;
    const named = runs.filter((run): run is string => typeof run === "string" && run.trim().length > 0);
    if (named.length > 0) return named.map((run) => run.trim());
  }
  return [];
}

/** Words sent into a running turn: they started no run of their own. */
function isSteer(message: Pick<ChatMessage, "metadata">): boolean {
  const intent = isRecord(message.metadata) ? message.metadata["sendIntent"] : null;
  return isRecord(intent) && intent["mode"] === "steer";
}

/** The prompt that started `run`, as its stored copy names it. */
function promptOfRun(messages: readonly ChatMessage[], run: string): ChatMessage | null {
  return messages.find((message) =>
    message.role === "user" && runOf(message) === run && !isSteer(message) && message.content.trim().length > 0,
  ) ?? null;
}

/**
 * The card a prompt carries on: the one a browser turn continued, or the one
 * whose browser turn a hand-back took back to the building turn (the
 * controller's record on its stored prompt).
 */
function cardKeyOf(prompt: ChatMessage): string | null {
  const continued = readBrowserRequestOf(prompt);
  if (continued) return continued;
  for (const record of promptRecords(prompt)) {
    const stamped = record["browserHandBack"];
    if (isRecord(stamped) && typeof stamped["cardJobId"] === "string" && stamped["cardJobId"].trim()) {
      return `job:${stamped["cardJobId"].trim()}`;
    }
  }
  return null;
}

/** The run whose turn posted the card with this key. */
function runOfCard(messages: readonly ChatMessage[], key: string): string | null {
  const card = messages.find((message) => browserRequestFromMessage(message) !== null && browserRequestKey(message) === key);
  return card ? runOf(card) : null;
}

/**
 * The person's own message a prompt carries on, as the runtime finds the
 * words of a request (`persons_request_at`, runtime-agent
 * `jobs/conversation_context.rs`): the prompt itself when they wrote it; for a
 * press of Continue, the request its Stop ended; for a card's browser turn, or
 * a hand-back of what one found, the message whose turn posted the card; for a
 * press of Let Octo continue, the request of the turn it goes on with. Null
 * when the chat does not hold it.
 */
function personsRequestOf(messages: readonly ChatMessage[], prompt: ChatMessage): ChatMessage | null {
  let at = prompt;
  for (let hops = 0; hops <= messages.length; hops += 1) {
    const continued = continuedRunsOf(at)[0] ?? null;
    const card = continued ? null : cardKeyOf(at);
    const letOctoContinue = !continued && !card && isLetOctoContinuePrompt(at);
    if (!continued && !card && !letOctoContinue) return at;
    const run = continued
      ?? (card ? runOfCard(messages, card) : promptString(at, BROWSER_CONTINUES_RUN_METADATA_KEY));
    const next = run ? promptOfRun(messages, run) : null;
    if (!next || next.id === at.id) return null;
    at = next;
  }
  return null;
}

/**
 * What Continue carries on under a Stop: the person's own message of the
 * newest turn the Stop ended and, when that turn was the build after a
 * browser turn that had finished (a hand-back), that hand-back.
 */
export function stoppedRequestOf(
  messages: readonly ChatMessage[],
  notice: ChatMessage,
): { request: ChatMessage; handBack: ChatMessage | null } | null {
  let stopped: ChatMessage | null = null;
  let newest = -1;
  for (const run of readChatRunStopNotice(notice).runIds) {
    const prompt = promptOfRun(messages, run);
    const index = prompt ? messages.indexOf(prompt) : -1;
    if (prompt && index > newest) {
      stopped = prompt;
      newest = index;
    }
  }
  const request = stopped ? personsRequestOf(messages, stopped) : null;
  if (!stopped || !request) return null;
  return { request, handBack: readBrowserHandBackOf(stopped) ? stopped : null };
}

/**
 * Whether someone wrote in the chat after `message`: a later turn has taken
 * the chat on from there.
 */
function writtenAfter(messages: readonly ChatMessage[], message: ChatMessage): boolean {
  const index = messages.findIndex((entry) => entry.id === message.id);
  return index >= 0 && messages.slice(index + 1).some((entry) => entry.role === "user");
}

/**
 * Continue under a Stop carries the stopped turn on, in nobody's words, and
 * leaves the person's composer draft alone. When the browser turn of a
 * message had finished and the Stop came before or during its build, the
 * build starts again from what that turn found: the same hand-back, which the
 * controller checks as any (runtime-controller `browser_hand_back.rs`), with
 * no routing step and no browser turn. Otherwise the stopped request runs
 * again under its own words. Neither is a bubble of the person's
 * (`continuePromptIds`), and the save is named by the request either way.
 */
export function useChatRunStopContinuation(options: Options) {
  const current = useRef(options);
  current.current = options;
  const submitted = useRef(new Set<string>());
  const canContinue = useCallback((message: ChatMessage) => {
    const state = current.current;
    const notice = readChatRunStopNotice(message);
    const key = `${state.conversationId}:${message.id}`;
    return Boolean(state.conversationId && state.viewerUserId && state.canWrite && !state.busy
      && notice.requested && notice.handles.length && notice.jobIds.length && notice.runIds.length
      && state.messages.some((entry) => entry.id === message.id)
      // Only the chat's latest turn: once anyone wrote after the stop, a later
      // turn took the chat on, and carrying the stopped one on would go back
      // to where it no longer is. The chat holds both, after a reload too;
      // with its newer messages not shown, nobody can tell.
      && !state.hasNewer && !writtenAfter(state.messages, message)
      && !submitted.current.has(key)
      && !state.messages.some((entry) => readContinuedStop(entry) === message.id)
      && !state.queuedSends.some((entry) => readContinuedStop({ role: "user", metadata: entry.metadata ?? null }) === message.id)
      // The person undid what the stopped turn changed: carrying it on would
      // put back what they took back.
      && !state.messages.some((entry) => {
        const undone = readChangeUndone(entry);
        return Boolean(undone?.runId && notice.runIds.includes(undone.runId));
      })
      // It carries on a request the chat shows, in that request's words, so
      // only for the person who asked it.
      && stoppedRequestOf(state.messages, message)?.request.authorId === state.viewerUserId);
  }, []);
  const onContinue = useCallback(async (message: ChatMessage) => {
    if (!canContinue(message)) return false;
    const state = current.current;
    const key = `${state.conversationId}:${message.id}`;
    const notice = readChatRunStopNotice(message);
    const stopped = stoppedRequestOf(state.messages, message);
    if (!stopped) return false;
    const metadata = { [CONTINUED_STOP_METADATA_KEY]: message.id, continuedRunIds: notice.runIds };
    submitted.current.add(key);
    let accepted = false;
    try {
      // A build the controller would not start again (the lane is busy, or
      // another page already did) sends nothing else: the row says so, and
      // keeps Continue.
      if (stopped.handBack && state.resendHandBack && Date.now() - message.timestamp < HAND_BACK_WINDOW_MS) {
        accepted = await state.resendHandBack(stopped.handBack, metadata);
        return accepted;
      }
      const sent = await state.submitMessage({
        message: stopped.request.content,
        editorState: null,
        targetAgentHandles: notice.handles,
        metadata,
      }, { automatic: true, intent: "send", onQueued: () => { accepted = true; } });
      accepted = sent || accepted;
      return accepted;
    } finally {
      if (!accepted) submitted.current.delete(key);
    }
  }, [canContinue]);
  return {
    viewerUserId: options.viewerUserId,
    humanLabelByUserId: options.humanLabelByUserId,
    canContinue,
    onContinue,
  };
}
