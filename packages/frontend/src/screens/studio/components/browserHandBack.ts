import { isRunFailureRecentForAutoRetry } from "../../../conversations/runFailurePresentation";
import { didSendFailForPromptSentFromThisPage } from "../../../conversations/sentPromptRegistry";
import type { RunStatus } from "../../../types";
import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import {
  BROWSER_HANDS_BACK_METADATA_KEY,
  BROWSER_REQUEST_OF_METADATA_KEY,
  browserRequestJobId,
  isBrowserTurnPromptMetadata,
  isUnsentBrowserRequestNotice,
  readBrowserRequestOf,
} from "./browserRequest";

/**
 * Hand-back: once a browser turn that continued Octo's card for something it
 * builds finishes, Studio sends one turn back to the building lane, so Octo
 * keeps building with what the browser found. A card for a question gets no
 * hand-back: the browser turn's reply is the answer. The prompt names the browser job; the controller checks
 * it and gives the turn the browser's reply as quoted page data, never as the
 * person's words or consent (runtime-controller `browser_hand_back.rs`). The
 * claim key and prompt are pinned in
 * packages/runtime-controller/src/browser_hand_back_fixtures.json.
 */
export const BROWSER_HAND_BACK_CLAIM_KEY = "continuesFromBrowserJob";
/** The controller's checked record on a hand-back prompt; its copy names the browser job. */
export const BROWSER_HAND_BACK_RECORD_KEY = "browserHandBack";
/** What the hand-back turn is asked; the findings come from the controller. */
export const BROWSER_HAND_BACK_PROMPT = "Continue building with what the browser turn found.";
/**
 * The runtime's Details note on a browser turn that carried on a card the
 * routing step posted for the person's own message, opened no page, and asked
 * Octo to make what the message asks: a browser turn cannot make it. The
 * message goes to the building turn as a hand-back, and the controller stamps
 * the record with {@link BROWSER_BUILD_REQUEST_RECORD_KEY}.
 */
export const BROWSER_BUILD_REQUEST_NOTE_KEY = "browserBuildRequest";
export const BROWSER_BUILD_REQUEST_RECORD_KEY = "buildRequest";

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

/** The browser job a prompt's metadata hands back: the claim as sent, or the controller's copy. */
export function browserHandBackOfPromptMetadata(metadata: unknown): string | null {
  for (const record of promptMetadataRecords(metadata)) {
    const claim = record[BROWSER_HAND_BACK_CLAIM_KEY];
    if (typeof claim === "string" && claim.trim()) return claim.trim();
    const stamped = record[BROWSER_HAND_BACK_RECORD_KEY];
    if (isRecord(stamped) && typeof stamped.browserJobId === "string" && stamped.browserJobId.trim()) {
      return stamped.browserJobId.trim();
    }
  }
  return null;
}

/** The browser job a hand-back prompt continues; null for any other message. */
export function readBrowserHandBackOf(message: Pick<ChatMessage, "role" | "metadata">): string | null {
  return message.role === "user" ? browserHandBackOfPromptMetadata(message.metadata) : null;
}

/**
 * A prompt Studio sent for Octo rather than words the person wrote: a
 * continuation of a browser card, or a hand-back. The chat shows it as a
 * one-line notice.
 */
export function isBrowserNoticePrompt(message: Pick<ChatMessage, "role" | "metadata">): boolean {
  return readBrowserRequestOf(message) !== null || readBrowserHandBackOf(message) !== null;
}

/**
 * Such a prompt whose dispatch failed: the controller never took it, so it
 * shows nothing. A card keeps its button with the error; a refused hand-back
 * leaves the browser turn's reply as the last word.
 */
export function isUnsentBrowserNoticePrompt(message: Pick<ChatMessage, "id" | "role" | "metadata">): boolean {
  return isUnsentBrowserRequestNotice(message) ||
    (readBrowserHandBackOf(message) !== null && didSendFailForPromptSentFromThisPage(message));
}

/**
 * The one-line record a hand-back leaves in the chat in place of its prompt:
 * "Octo continued with what it found in the browser".
 */
export function browserHandBackNotice(agentName: string): string {
  return `${agentName.trim() || "Octo"} continued with what it found in the browser`;
}

/**
 * What a hand-back of a message the browser turn could not make records in
 * place of its prompt. The chat leaves it out (routedBrowserFold.ts): the
 * person reads their message and then the building turn.
 */
export function browserBuildRequestNotice(agentName: string): string {
  return `${agentName.trim() || "Octo"} continued in the chat`;
}

function promptMetadataString(metadata: unknown, keys: readonly string[]): string | null {
  for (const record of promptMetadataRecords(metadata)) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/**
 * The browser turn stopped on a step that is the person's: it asked for their
 * input on the page, or a step's approval ended the turn. The person goes on
 * in the browser; nothing goes back to the building turn.
 */
export function browserTurnStoppedForPerson(messages: readonly ChatMessage[], jobId: string): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant" || browserRequestJobId(message) !== jobId) return false;
    if (getMessageType(message) !== "mcp_tool_call") return false;
    const details = extractMessageDetails(message.metadata);
    if (!details) return false;
    const consent = details.terminalConsent;
    if (isRecord(consent) && consent.state === "blocked") return true;
    return details.tool === "request_human_input" && details.status === "completed";
  });
}

/**
 * The browser turn asked Octo to make the person's message in the chat
 * ({@link BROWSER_BUILD_REQUEST_NOTE_KEY}): the runtime's note on it.
 */
export function browserTurnRequestedABuild(messages: readonly ChatMessage[], jobId: string): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant" || browserRequestJobId(message) !== jobId) return false;
    return isRecord(extractMessageDetails(message.metadata)?.[BROWSER_BUILD_REQUEST_NOTE_KEY]);
  });
}

/**
 * The browser turn read at least one page: the runtime's Details note of its
 * finding lines counts the pages it read (runtime-agent
 * `move_findings_into_details`). A turn that only says where it stopped gives
 * the building turn nothing to continue with.
 */
export function browserTurnReadAPage(messages: readonly ChatMessage[], jobId: string): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant" || browserRequestJobId(message) !== jobId) return false;
    const findings = extractMessageDetails(message.metadata)?.browserFindings;
    return isRecord(findings) && typeof findings.pagesRead === "number" && findings.pagesRead > 0;
  });
}

export type BrowserHandBackInput = {
  messages: readonly ChatMessage[];
  /** When this conversation was opened here: history never hands back. */
  openedAtMs: number;
  /** Run and job ids still working in this conversation. */
  activeRunIds: ReadonlySet<string>;
  /** A run's status by its run or job id; null when unknown. */
  runStatus: (id: string) => RunStatus | null;
  /** The prompt this page sent that started a run or job (findPromptSentFromThisPageForRun). */
  sentPromptForRun: (id: string) => { metadata: unknown } | null;
  nowMs?: number;
};

/**
 * The browser job whose findings go back to the building turn now, or null.
 * Only when, all together:
 * - the newest message is that browser turn's (nobody wrote after it);
 * - this page sent both the browser continuation and the prompt whose turn
 *   sent the card, so another viewer, device, reload or worker never does;
 * - the card's turn was neither a browser turn nor a hand-back: one hop only;
 * - the card continues building (a page, a map): a question's browser turn
 *   already answered it, and a second turn would only repeat the answer;
 * - the browser turn finished successfully, recently, after the conversation
 *   was opened here, read at least one page, and did not stop for a step of
 *   the person's;
 * - no hand-back for it was sent yet.
 * A browser turn that asked Octo to make the person's message
 * ({@link browserTurnRequestedABuild}) needs neither a building card nor a
 * page read: it hands the message itself back.
 * The controller checks the same chain again and refuses anything else.
 */
export function browserHandBackCandidate(input: BrowserHandBackInput): string | null {
  const { messages } = input;
  let newest: ChatMessage | null = null;
  let jobId: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return null;
    const id = browserRequestJobId(message);
    if (id) {
      newest = message;
      jobId = id;
      break;
    }
  }
  if (!newest || !jobId) return null;
  const requestedABuild = browserTurnRequestedABuild(messages, jobId);
  // This page sent the browser turn: a continuation of a card, in a browser.
  const continuation = input.sentPromptForRun(jobId);
  const cardKey = continuation
    ? promptMetadataString(continuation.metadata, [BROWSER_REQUEST_OF_METADATA_KEY])
    : null;
  if (!continuation || !cardKey?.startsWith("job:") ||
      !promptMetadataString(continuation.metadata, ["browserTransport", "browser_transport"]) ||
      (!requestedABuild &&
        !promptMetadataRecords(continuation.metadata).some((record) => record[BROWSER_HANDS_BACK_METADATA_KEY] === true))) {
    return null;
  }
  const card = input.sentPromptForRun(cardKey.slice("job:".length));
  if (!card || isBrowserTurnPromptMetadata(card.metadata) || browserHandBackOfPromptMetadata(card.metadata)) {
    return null;
  }
  if (input.activeRunIds.has(jobId) || input.runStatus(jobId) !== "success") return null;
  if (!isRunFailureRecentForAutoRetry(newest, input.nowMs) || newest.timestamp < input.openedAtMs - 1_000) {
    return null;
  }
  if (browserTurnStoppedForPerson(messages, jobId) ||
      !(requestedABuild || browserTurnReadAPage(messages, jobId))) {
    return null;
  }
  if (messages.some((message) => readBrowserHandBackOf(message) === jobId)) return null;
  return jobId;
}

// The browser jobs this page handed back (or started to), in module memory
// only: one hand-back per browser turn per page, whatever remounts.
const claimedHandBacks = new Set<string>();

/** Claims a browser job's hand-back for this page; false when it was claimed already. */
export function claimBrowserHandBack(jobId: string): boolean {
  if (claimedHandBacks.has(jobId)) return false;
  claimedHandBacks.add(jobId);
  return true;
}

/** Forgets every claim, as a reload would. Tests only. */
export function forgetBrowserHandBacksForTests(): void {
  claimedHandBacks.clear();
}
