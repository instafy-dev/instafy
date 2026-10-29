import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { displayActivityHost } from "./activityHost";
import {
  BROWSER_REQUEST_OF_METADATA_KEY,
  browserRequestDestinations,
  browserRequestFromMessage,
  browserRequestKey,
} from "./browserRequest";
import { browserSessionPageIsPlaceholder, type BrowserSessionPage } from "./browserSessionPages";
import { isActivityHost } from "./turnActivity";

/** A run of the chat that has not ended. */
const RUN_ON_ITS_WAY = new Set(["queued", "in_progress", "awaiting_approval"]);

/** A browser turn of a chat on its way to the browser, with the site its card named. */
export type BrowserTurnArrival = { site: string | null };

/** The site a card names, as the chat shows a site: no "www.", Unicode where it is safe. */
function cardSite(messages: readonly ChatMessage[], cardKey: string | null): string | null {
  if (!cardKey) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const request = browserRequestFromMessage(message);
    if (!request || browserRequestKey(message) !== cardKey) continue;
    const host = browserRequestDestinations(request.task)[0]?.replace(/^www\./u, "") ?? "";
    return isActivityHost(host) ? displayActivityHost(host) : null;
  }
  return null;
}

/**
 * A browser turn of this chat that runs, or waits to: the Browser view says
 * so over the blank tab it starts on, until its first page. The site is the
 * one the card it continues named; a turn without one names none.
 */
export function browserTurnArrival(
  runs: readonly RunRecord[],
  messages: readonly ChatMessage[],
): BrowserTurnArrival | null {
  const run = runs.find(
    (candidate) => RUN_ON_ITS_WAY.has(candidate.status) && candidate.metadata?.browserTransport === "shared",
  );
  if (!run) return null;
  const cardKey = run.metadata?.[BROWSER_REQUEST_OF_METADATA_KEY];
  return { site: cardSite(messages, typeof cardKey === "string" ? cardKey.trim() : null) };
}

/**
 * What the Browser view says over a blank tab while the chat's browser turn
 * is on its way: "Octo is opening visitlisboa.com…", or "Octo is starting…"
 * when its card named no site. Null once the tab shows a page.
 */
export function browserArrivalNote(
  arrival: BrowserTurnArrival | null,
  page: Pick<BrowserSessionPage, "url"> | null,
  agentName: string,
): string | null {
  if (!arrival || !page || !browserSessionPageIsPlaceholder(page)) return null;
  return arrival.site ? `${agentName} is opening ${arrival.site}…` : `${agentName} is starting…`;
}
