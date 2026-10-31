// A message Octo sent straight to Instafy's browser reads as one turn: the
// person's message, then the browser turn's own line and reply. Its job ran
// no model turn and posted only a routed card (`browserRequest.routed`),
// which Studio opens by itself where it can, sending the person's own words
// on as the browser turn's task. The chat leaves that continuation out (it
// repeats the person's message), and the card shows only the turn's one line,
// "Opening Instafy's browser…", until the browser turn shows something; then
// the card goes too. A routed card that stays a button (Studio could not
// open it by itself) or that the person pressed is never folded: it shows as
// any card does, with its reason.

import type { ChatMessage } from "../types";
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
};

/**
 * Links each routed card Studio opened by itself to the browser turn that
 * carries it on: the continuation names the card (`browserRequestOf`), and
 * its stored row names the run that turn's job reports under.
 */
export function resolveRoutedBrowserFold(messages: readonly ChatMessage[]): RoutedBrowserFold {
  const routedCards = new Map<string, ChatMessage>();
  const jobByRunId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (browserRequestFromMessage(message)?.routed) routedCards.set(browserRequestKey(message), message);
    const jobId = stringField(message, ["jobId", "job_id"]);
    const runId = stringField(message, ["runId", "run_id"]);
    if (jobId && runId && !jobByRunId.has(runId)) jobByRunId.set(runId, jobId);
  }
  const hiddenPromptIds = new Set<string>();
  const cardIdByBrowserJobId = new Map<string, string>();
  if (routedCards.size === 0) return { hiddenPromptIds, cardIdByBrowserJobId };
  for (const message of messages) {
    const key = readBrowserRequestOf(message);
    const card = key ? routedCards.get(key) : undefined;
    if (!card || !isAutoStartedContinuation(message) || isUnsentBrowserRequestNotice(message)) continue;
    hiddenPromptIds.add(message.id);
    const browserJobId = jobByRunId.get(stringField(message, ["runId", "run_id"]));
    if (browserJobId) cardIdByBrowserJobId.set(browserJobId, card.id);
  }
  return { hiddenPromptIds, cardIdByBrowserJobId };
}
