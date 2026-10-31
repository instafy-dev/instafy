import { createContext } from "react";
import { didSendFailForPromptSentFromThisPage } from "../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

export type BrowserRequest = {
  task: string;
  location: "auto" | "device" | "workspace";
  /**
   * Octo builds something (a page, a map) from what the browser finds, so
   * the browser turn hands its findings back (browserHandBack.ts). A card
   * for a question leaves it out: the browser turn's reply is the answer.
   */
  continueBuilding?: boolean;
  /**
   * Octo sent the person's message straight to the browser: its words are the
   * task, and when Studio opens the card by itself, the card and its
   * continuation fold into the browser turn (routedBrowserFold.ts).
   */
  routed?: true;
};

/**
 * What became of a card Studio considered starting by itself: it is opening,
 * it opened, or it stays a button, with the reason when there is one worth
 * telling the person.
 */
export type BrowserRequestCardState =
  | { kind: "opening"; note: string | null }
  | { kind: "opened" }
  | { kind: "button"; reason: string | null };

/** A card is opening Instafy's browser, by itself or after a press. */
export function anyBrowserCardOpening(cardStates: ReadonlyMap<string, BrowserRequestCardState>): boolean {
  for (const state of cardStates.values()) if (state.kind === "opening") return true;
  return false;
}

/**
 * What this Studio can open for a request_browser card. The card itself says
 * nothing about browsers. Instafy's Workspace browser starts on demand: on the
 * space's own machine where the controller reports `sharedBrowserHost` for it,
 * and otherwise as a runtime of its own. Studio opens it by itself only on the
 * conversation's own machine in a covered space (see browserAutoStartPlan).
 */
export type BrowserRequestHost = {
  transport: BrowserTransport;
  personalAvailable: boolean;
  /**
   * The Workspace browser is already known not to open here. Anything not
   * known yet, such as a browser that has not started, counts as available.
   */
  sharedUnavailable: boolean;
  /**
   * A turn in the browser on this device runs on this device's own runtime,
   * which Instafy AI does not reach: dispatch refuses it. False only when the
   * person's turns are known to use Instafy AI; absent counts as allowed.
   */
  personalTurnsAllowed?: boolean;
  /** Cards Studio considered starting by itself, by {@link browserRequestKey}. */
  cardStates?: ReadonlyMap<string, BrowserRequestCardState>;
  /** Cards a continuation was already sent for, by {@link browserRequestKey}. */
  continuedKeys?: ReadonlySet<string>;
  /**
   * The conversation's newest card, by {@link browserRequestKey}. An older
   * card no longer offers its button: the newer one carries the task on.
   */
  newestCardKey?: string | null;
};

/**
 * Provided by ChatPanel. Without it (thread previews, tests) a card is shown
 * as it always was and the press reports any failure.
 */
export const BrowserRequestHostContext = createContext<BrowserRequestHost | null>(null);

export function browserRequestFromMessage(message: ChatMessage): BrowserRequest | null {
  if (message.role !== "assistant") return null;
  if (getMessageType(message) !== "action_request") return null;
  const details = extractMessageDetails(message.metadata);
  const value = details?.browserRequest as Record<string, unknown> | undefined;
  if (!value || typeof value.task !== "string" || !value.task.trim() || value.task.length > 8_000) return null;
  if (value.location !== "auto" && value.location !== "device" && value.location !== "workspace") return null;
  return {
    task: value.task.trim(),
    location: value.location,
    ...(value.continueBuilding === true ? { continueBuilding: true } : {}),
    ...(value.routed === true ? { routed: true as const } : {}),
  };
}

type BrowserRequestHostAvailability = Pick<BrowserRequestHost, "personalAvailable" | "sharedUnavailable" | "personalTurnsAllowed">;

export function browserRequestTransport(
  request: BrowserRequest,
  current: BrowserTransport,
  host: BrowserRequestHostAvailability | null = null,
): BrowserTransport {
  if (request.location === "device") return "personal";
  if (request.location === "workspace") return "shared";
  // "auto" keeps the selected browser, unless that is the Workspace browser,
  // it is known not to open here, and the browser on this device can.
  if (host && current === "shared" && host.personalAvailable && host.sharedUnavailable &&
      host.personalTurnsAllowed !== false) {
    return "personal";
  }
  // Nor does it pick this device's browser for turns dispatch would refuse
  // there (Instafy AI), while Instafy's browser can still open.
  if (host && current === "personal" && host.personalTurnsAllowed === false && !host.sharedUnavailable) {
    return "shared";
  }
  return current;
}

/** Why pressing this card cannot open a browser here, or null when it can. */
export function browserRequestUnavailableReason(request: BrowserRequest, host: BrowserRequestHost): string | null {
  const transport = browserRequestTransport(request, host.transport, host);
  if (transport === "personal") {
    if (!host.personalAvailable) return "This uses the browser on your device. Open this chat in the Instafy desktop app to continue.";
    return host.personalTurnsAllowed === false ? "The browser on this device needs your own AI connection." : null;
  }
  return host.sharedUnavailable ? "Instafy's browser is not available in this workspace." : null;
}

const ADDRESS_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const LEADING_HOST_PATTERN = /^\s*(?:please\s+)?(?:open|go to|visit)\s+((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?=[/:\s,;)]|\.?$|\.\s)/i;

/**
 * The hosts a card's task is headed for, as the card shows them: every
 * http(s) address in the task, or else the host a task opens with
 * ("Open app.example.com and ..."). At most three, in order, without repeats.
 * They come from the task's text, not from the page the browser reached, so
 * copy names them as a destination only.
 */
export function browserRequestDestinations(task: string): string[] {
  const hosts: string[] = [];
  const add = (host: string) => {
    const normalized = host.toLowerCase().replace(/\.$/, "");
    if (normalized && !hosts.includes(normalized)) hosts.push(normalized);
  };
  for (const match of task.matchAll(ADDRESS_PATTERN)) {
    try {
      add(new URL(match[0]).hostname);
    } catch {
      // Not an address after all.
    }
  }
  if (hosts.length === 0) {
    const leading = LEADING_HOST_PATTERN.exec(task);
    if (leading?.[1]) add(leading[1]);
  }
  return hosts.slice(0, 3);
}

/**
 * What a card's continuation sends: its task alone, in Octo's words for the
 * person's request. `browserRequestOf` in its metadata marks it as the card's,
 * and its tab reaches the browser turn as the turn's own page, so nothing goes
 * in front: a line about "the browser attached to this turn" came back in
 * replies as "the attached browser".
 */
export function browserRequestContinuation(request: BrowserRequest): string {
  return request.task;
}

/** What went in front of a continuation's task before, read back from older prompts only. */
const OLDER_CONTINUATION_PREFIX =
  "Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.";

/**
 * Prompt metadata naming the card a continuation was sent for, by
 * {@link browserRequestKey}. It marks the prompt as Octo's request rather
 * than the person's own words, and the card as answered, also after a reload.
 */
export const BROWSER_REQUEST_OF_METADATA_KEY = "browserRequestOf";
/** Prompt metadata on a continuation Studio sent by itself, without a press. */
export const BROWSER_AUTO_STARTED_METADATA_KEY = "browserAutoStarted";
/**
 * Prompt metadata naming the sites of the browser cards the person pressed
 * in this chat. A card names its site, so pressing it is the person's OK for
 * that site: the runtime starts each later Instafy's browser turn of the chat
 * with those sites approved on the person's page. Only a press counts, never
 * a card Studio opened by itself, and the controller keeps it only on the
 * person's own message.
 */
export const BROWSER_CARD_SITES_METADATA_KEY = "browserCardSites";
const MAX_BROWSER_CARD_SITES = 8;
/**
 * Prompt metadata on a continuation of a card that continues building: the
 * browser turn ends with labelled findings for the hand-back (runtime-agent
 * `browser_hand_back.rs`), and only such a turn is handed back.
 */
export const BROWSER_HANDS_BACK_METADATA_KEY = "browserHandsBack";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptMetadataRecords(metadata: unknown): Record<string, unknown>[] {
  if (!isRecord(metadata)) return [];
  const records = [metadata];
  for (const key of ["prompt_metadata", "promptMetadata"]) {
    const nested = metadata[key];
    if (isRecord(nested)) records.push(nested);
  }
  return records;
}

function readJobId(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  for (const key of ["jobId", "job_id"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * A card's identity. The controller stamps the job that sent it, and a turn
 * sends at most one card, so the job outlasts a message id that changes once
 * the card is stored. A card without a job falls back to its message id.
 */
export function browserRequestKey(message: Pick<ChatMessage, "id" | "metadata">): string {
  const jobId = readJobId(message.metadata);
  return jobId ? `job:${jobId}` : `message:${message.id}`;
}

/** The key of the newest card in these messages, or null when there is none. */
export function newestBrowserRequestKey(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (browserRequestFromMessage(message)) return browserRequestKey(message);
  }
  return null;
}

/** The job that sent a card, when the controller stamped one. */
export function browserRequestJobId(message: Pick<ChatMessage, "metadata">): string | null {
  return readJobId(message.metadata);
}

/** The card a prompt continued, from its own or its stored prompt metadata. */
export function readBrowserRequestOf(message: Pick<ChatMessage, "role" | "metadata">): string | null {
  if (message.role !== "user") return null;
  for (const record of promptMetadataRecords(message.metadata)) {
    const value = record[BROWSER_REQUEST_OF_METADATA_KEY];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** A continuation Studio sent for a card by itself, without a press. */
export function isAutoStartedContinuation(message: Pick<ChatMessage, "metadata">): boolean {
  return promptMetadataRecords(message.metadata).some((record) => record[BROWSER_AUTO_STARTED_METADATA_KEY] === true);
}

/**
 * The sites of the cards the person pressed in a chat, oldest first: each
 * continuation they sent by pressing a card, read back from its own prompt.
 * Only the person's own presses count: in a shared chat, a teammate's press
 * is that teammate's OK, never this person's.
 */
export function pressedBrowserCardSites(
  messages: readonly ChatMessage[],
  currentUserId: string | null | undefined,
): string[] {
  const person = currentUserId?.trim() ?? "";
  if (!person) return [];
  const sites: string[] = [];
  for (const message of messages) {
    if (message.authorId?.trim() !== person || !readBrowserRequestOf(message) ||
        isUnsentBrowserRequestNotice(message) || isAutoStartedContinuation(message)) {
      continue;
    }
    const request = browserRequestFromContinuationPrompt(message);
    if (request) sites.push(...browserRequestDestinations(request.task));
  }
  return mergeBrowserCardSites(sites);
}

/** One list of card sites, without repeats, at most the runtime's bound (the newest kept). */
export function mergeBrowserCardSites(...lists: ReadonlyArray<unknown>): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const site of list) {
      if (typeof site !== "string") continue;
      const host = site.trim().toLowerCase();
      if (!host) continue;
      const seen = merged.indexOf(host);
      if (seen >= 0) merged.splice(seen, 1);
      merged.push(host);
    }
  }
  return merged.slice(-MAX_BROWSER_CARD_SITES);
}

/** True when a prompt's metadata routes it to a browser or continues a card. */
export function isBrowserTurnPromptMetadata(metadata: unknown): boolean {
  return promptMetadataRecords(metadata).some((record) => {
    const transport = record["browserTransport"] ?? record["browser_transport"];
    return (typeof transport === "string" && transport.trim().length > 0) ||
      (typeof record[BROWSER_REQUEST_OF_METADATA_KEY] === "string");
  });
}

/**
 * A continuation this page sent whose dispatch failed: the controller never
 * took it, so it opened nothing and continues no card.
 */
export function isUnsentBrowserRequestNotice(message: Pick<ChatMessage, "id" | "role" | "metadata">): boolean {
  return readBrowserRequestOf(message) !== null && didSendFailForPromptSentFromThisPage(message);
}

/** Cards a continuation was sent for, by {@link browserRequestKey}. */
export function browserRequestContinuedKeys(messages: readonly ChatMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    const key = readBrowserRequestOf(message);
    if (key && !isUnsentBrowserRequestNotice(message)) keys.add(key);
  }
  return keys;
}

/**
 * The task a continuation sent, read back from its own prompt: the stored
 * prompt keeps what it dispatched as `dispatchContent` (after the line older
 * continuations put in front). Its browser is the one it ran in. Null when
 * the prompt is not a continuation or carries no task (its dispatched text is
 * its own notice), so a retry never resends the notice in its place.
 */
export function browserRequestFromContinuationPrompt(
  message: Pick<ChatMessage, "role" | "metadata" | "content">,
): BrowserRequest | null {
  if (!readBrowserRequestOf(message)) return null;
  const notice = typeof message.content === "string" ? message.content.trim() : "";
  for (const record of promptMetadataRecords(message.metadata)) {
    const dispatched = record["dispatchContent"];
    if (typeof dispatched !== "string") continue;
    let task = dispatched.trim();
    if (task.startsWith(OLDER_CONTINUATION_PREFIX)) task = task.slice(OLDER_CONTINUATION_PREFIX.length).trim();
    if (!task || task.length > 8_000 || task === notice) continue;
    const transport = record["browserTransport"] ?? record["browser_transport"];
    const location = transport === "shared" ? "workspace" : transport === "desktop-personal" ? "device" : "auto";
    const continueBuilding = promptMetadataRecords(message.metadata)
      .some((entry) => entry[BROWSER_HANDS_BACK_METADATA_KEY] === true);
    return { task, location, ...(continueBuilding ? { continueBuilding: true } : {}) };
  }
  return null;
}

/**
 * The one-line record a continuation leaves in the chat, in place of the task
 * it sent: "Opened Instafy's browser for dashboard.stripe.com". It names Octo
 * only when Studio opened the browser by itself ("Octo opened Instafy's
 * browser for …"); after the person's own press it never says Octo did it.
 * The host is where the task is headed; the browser may not have loaded it
 * yet.
 */
export function browserRequestNotice(
  agentName: string,
  task: string,
  options: { automatic?: boolean } = {},
): string {
  const opened = options.automatic ? `${agentName.trim() || "Octo"} opened` : "Opened";
  const [host] = browserRequestDestinations(task);
  return host ? `${opened} Instafy's browser for ${host}` : `${opened} Instafy's browser`;
}
