// A message Octo sent straight to Instafy's browser reads as one turn: the
// person's message, then the browser turn's own line and reply. Its job ran
// no model turn and posted only a routed card (`browserRequest.routed`),
// which Studio opens by itself where it can, sending the person's own words
// on as the browser turn's task. The chat leaves that continuation out (it
// repeats the person's message), and the card shows only the turn's one line,
// "Opening Instafy's browser…", until the browser turn shows something; then
// the card goes too. A routed card that stays a button (Studio could not
// open it by itself) or that the person pressed is never folded: it shows as
// any card does, with its reason, and reads Opened once pressed. So does one
// whose browser turn failed before it ran: nothing is opening any more.

import { hasFailedRunMetadata } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import {
  browserRequestFromMessage,
  browserRequestKey,
  isAutoStartedContinuation,
  isUnsentBrowserRequestNotice,
  readBrowserRequestOf,
} from "./browserRequest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(message: ChatMessage, keys: readonly string[]): string {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export type RoutedBrowserFold = {
  /** Continuations Studio sent by itself for routed cards. */
  hiddenPromptIds: ReadonlySet<string>;
  /** The browser turn's job, to the routed card it carries on. */
  cardIdByBrowserJobId: ReadonlyMap<string, string>;
  /**
   * Routed cards, by {@link browserRequestKey}, whose continuation Studio
   * sent by itself and whose browser turn has not failed before it ran: the
   * card reads "Opening Instafy's browser…" until that turn shows something.
   */
  waitingCardKeys: ReadonlySet<string>;
};

/** A failure posted for a run that no job ran (the run's job never started). */
function failedBeforeAJobRan(message: ChatMessage): boolean {
  return message.role === "assistant" &&
    !stringField(message, ["jobId", "job_id"]) &&
    ((getMessageType(message) ?? "").trim().toLowerCase() === "error" || hasFailedRunMetadata(message.metadata));
}

/**
 * Links each routed card Studio opened by itself to the browser turn that
 * carries it on: the continuation names the card (`browserRequestOf`), and
 * its stored row names the run that turn's job reports under.
 */
export function resolveRoutedBrowserFold(messages: readonly ChatMessage[]): RoutedBrowserFold {
  const routedCards = new Map<string, ChatMessage>();
  const jobByRunId = new Map<string, string>();
  const runsFailedBeforeAJob = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (browserRequestFromMessage(message)?.routed) routedCards.set(browserRequestKey(message), message);
    const jobId = stringField(message, ["jobId", "job_id"]);
    const runId = stringField(message, ["runId", "run_id"]);
    if (jobId && runId && !jobByRunId.has(runId)) jobByRunId.set(runId, jobId);
    if (runId && failedBeforeAJobRan(message)) runsFailedBeforeAJob.add(runId);
  }
  const hiddenPromptIds = new Set<string>();
  const cardIdByBrowserJobId = new Map<string, string>();
  const waitingCardKeys = new Set<string>();
  if (routedCards.size === 0) return { hiddenPromptIds, cardIdByBrowserJobId, waitingCardKeys };
  for (const message of messages) {
    const key = readBrowserRequestOf(message);
    const card = key ? routedCards.get(key) : undefined;
    if (!key || !card || !isAutoStartedContinuation(message) || isUnsentBrowserRequestNotice(message)) continue;
    hiddenPromptIds.add(message.id);
    const runId = stringField(message, ["runId", "run_id"]);
    const browserJobId = jobByRunId.get(runId);
    if (browserJobId) cardIdByBrowserJobId.set(browserJobId, card.id);
    if (!runsFailedBeforeAJob.has(runId)) waitingCardKeys.add(key);
  }
  return { hiddenPromptIds, cardIdByBrowserJobId, waitingCardKeys };
}

/** Routed cards still opening by themselves ({@link RoutedBrowserFold.waitingCardKeys}). */
export function routedBrowserWaitingKeys(messages: readonly ChatMessage[]): ReadonlySet<string> {
  return resolveRoutedBrowserFold(messages).waitingCardKeys;
}
