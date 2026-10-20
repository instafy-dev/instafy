import type { ControllerRuntimeStatusEntry } from "../../../services/runtimeController";
import type { ChatMessage } from "../types";
import {
  isManagedInstafyCloudProvider,
  listBrowserSessionCandidates,
  runtimeEntryIsLazyBrowserHost,
} from "./browserSessionRuntimeEnsure";
import { browserRequestJobId, readBrowserRequestOf } from "./browserRequest";
import { getMessageType } from "./chatMessageMetadata";
import { shouldDisplayChatMessage } from "./chatMessagePresentation";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

/**
 * How Studio starts a request_browser card by itself (owner decision, Oct 19:
 * Octo opens Instafy's browser on its own, and never starts or restarts a
 * cloud machine to do it).
 *
 * - `personal`: the browser in this desktop app, for a person on their own AI.
 *   It asks for the person's chosen approval mode, as a press does.
 * - `button`: the card stays a button, with the reason when there is one.
 *
 * Instafy's hosted browser always waits for a press. Studio cannot tell whose
 * running session it is (the controller does not record who started one, so
 * it may be a teammate's, with their pages and sign-ins), and opening a new
 * one starts a machine or switches the space's own machine to the browser,
 * which stops whatever it still runs, such as a preview, a dev server or a
 * terminal session, that Studio cannot see.
 */
export type BrowserAutoStartPlan =
  | { kind: "personal" }
  | { kind: "button"; reason: string | null };

/**
 * Who else is in Instafy's hosted browser, from its collaboration roster:
 * `unknown` until the roster connects, `unavailable` when it cannot. Another
 * person or agent run in control of it holds a card for the person.
 */
export type SharedBrowserPresence = {
  status: "unknown" | "known" | "unavailable";
  /** Someone else has this browser open. */
  othersPresent: boolean;
  /** Another person or an agent run controls it. */
  remoteController: boolean;
};

export const BROWSER_AUTO_START_COPY = {
  secondMachine: "This starts a second cloud machine for this space.",
  anotherMachine: "This starts another cloud machine for this space.",
  firstMachine: "This starts a cloud machine for this space.",
  restartsMachine: "This restarts this space's cloud machine as the browser, which stops anything still running on it.",
  inUse: "Instafy's browser is in use. Open it when it is free.",
  otherSession: "A browser session is already running in this space. Open it when you are ready.",
  severalSessions: "Several browser sessions are running in this space. Open the one you want.",
  personalNeedsOwnAi: "The browser on this device needs your own AI connection.",
  unseenAddress: "Octo found this address itself. Check where it goes, then open it.",
  timedOut: "Instafy's browser did not start in time. Open it from the message to try again.",
} as const;

/** The display name Studio gives the space's own standard hosted machine. */
const GENERIC_HOSTED_RUNTIME_DISPLAY_NAME = "hosted runtime";
const ENDED_RUNTIME_STATUSES = new Set([
  "stopped",
  "stopping",
  "failed",
  "terminated",
  "expired",
  "deleted",
  "removed",
]);

export type BrowserAutoStartPlanInput = {
  /** The browser the card resolved to (see browserRequestTransport). */
  transport: BrowserTransport;
  personalAvailable: boolean;
  /** True only when the person's turns are known to run on their own AI. */
  personalOwnAi: boolean;
  projectId: string | null;
  /** This space's runtimes as the controller last reported them; null when unknown. */
  runtimes: readonly ControllerRuntimeStatusEntry[] | null;
};

function isLiveHostedMachine(entry: ControllerRuntimeStatusEntry): boolean {
  return isManagedInstafyCloudProvider(entry.provider) &&
    entry.isLocal === false &&
    entry.isPrivateSelfHosted !== true &&
    !ENDED_RUNTIME_STATUSES.has(entry.status.trim().toLowerCase());
}

/** What Studio may do by itself for a card. */
export function browserAutoStartPlan(input: BrowserAutoStartPlanInput): BrowserAutoStartPlan {
  if (input.transport === "personal") {
    if (!input.personalAvailable) return { kind: "button", reason: null };
    return input.personalOwnAi
      ? { kind: "personal" }
      : { kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi };
  }
  // Instafy's hosted browser: the card stays a button, saying what a press
  // would open.
  const projectId = input.projectId?.trim() ?? "";
  if (!projectId || !input.runtimes) return { kind: "button", reason: null };
  // Only separate browser session machines count as a running session; the
  // space's own machine with Instafy's browser on demand is not one.
  const sessions = listBrowserSessionCandidates([...input.runtimes]);
  if (sessions.length > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.severalSessions };
  // Whoever started it: the controller does not record that.
  if (sessions.length === 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession };
  // Opening a browser here would start a machine, or restart this space's
  // own one.
  const machines = input.runtimes.filter(isLiveHostedMachine);
  if (machines.length === 0) return { kind: "button", reason: BROWSER_AUTO_START_COPY.firstMachine };
  if (machines.length > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.anotherMachine };
  // Instafy's browser on the space's own machine opens in place; a press
  // neither restarts nor adds a machine.
  if (runtimeEntryIsLazyBrowserHost(machines[0])) return { kind: "button", reason: null };
  const displayName = machines[0]!.displayName?.trim().toLowerCase() ?? "";
  return {
    kind: "button",
    reason: displayName === GENERIC_HOSTED_RUNTIME_DISPLAY_NAME
      ? BROWSER_AUTO_START_COPY.restartsMachine
      : BROWSER_AUTO_START_COPY.secondMachine,
  };
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
// A bare host such as dashboard.stripe.com, not the domain of an email
// address and not followed by more labels.
const BARE_HOST_PATTERN =
  /(^|[^a-z0-9@._-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?=$|[^a-z0-9.-]|\.(?![a-z0-9]))/gi;
const IPV4_PATTERN = /(^|[^0-9.])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^0-9.]|\.(?![0-9]))/g;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * Whether the person's draft or layout leaves a card to them for now: a draft
 * in the composer, a layout too narrow to show the browser beside the chat, or
 * side-by-side view turned off, where the browser would cover the chat.
 */
export function browserAutoStartHeldByComposerOrLayout(input: {
  draft: string;
  wideSurfaces: boolean;
  splitView: boolean;
}): boolean {
  return input.draft.trim().length > 0 || !input.wideSurfaces || !input.splitView;
}

/**
 * Every host a text names: in http(s) addresses, as bare domains, and as
 * IPv4 addresses. Broader than the hosts a card shows, because an address
 * anywhere in a task is somewhere the browser may go.
 */
export function hostsNamedIn(text: string): Set<string> {
  const hosts = new Set<string>();
  const add = (host: string) => {
    const normalized = normalizeHost(host);
    if (normalized) hosts.add(normalized);
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      add(new URL(match[0]).hostname);
    } catch {
      // Not an address after all.
    }
  }
  for (const match of text.matchAll(BARE_HOST_PATTERN)) add(match[2]!);
  for (const match of text.matchAll(IPV4_PATTERN)) add(match[2]!);
  return hosts;
}

// Address forms Studio cannot compare with what the person read, so a task
// naming one always leaves its card to the person: localhost (with or without
// a port or path), IPv6 literals, internationalized hosts and hosts written
// with a fullwidth or ideographic dot.
const LOCALHOST_PATTERN = /(^|[^a-z0-9-])localhost(?![a-z0-9-])/i;
const IPV6_BRACKETED_PATTERN = /\[[0-9a-f]*:[0-9a-z:.%]*\]/i;
const IPV6_COMPRESSED_PATTERN =
  /(^|[^0-9a-z:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::|::[0-9a-f]{1,4})/i;
const IPV6_FULL_PATTERN = /(^|[^0-9a-z:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}/i;
// Labels of any script joined by an ASCII, fullwidth or ideographic dot.
const UNICODE_HOST_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*(?:[.\u3002\uFF0E\uFF61][\p{L}\p{N}][\p{L}\p{N}\p{M}-]*)+/gu;
const NON_ASCII_PATTERN = /\P{ASCII}/u;

function namesUnicodeHost(text: string): boolean {
  for (const [candidate] of text.matchAll(UNICODE_HOST_PATTERN)) {
    if (!NON_ASCII_PATTERN.test(candidate)) continue;
    const labels = candidate.split(/[.\u3002\uFF0E\uFF61]/u);
    const separators: string[] = candidate.match(/[.\u3002\uFF0E\uFF61]/gu) ?? [];
    // A fullwidth or ideographic dot before an ASCII label, as in
    // "example．com". A CJK sentence that ends in an ideographic full stop
    // is not one.
    if (separators.some((separator, index) => separator !== "." && /^[a-z0-9]/i.test(labels[index + 1] ?? ""))) {
      return true;
    }
    // An internationalized domain, as in "bücher.de": an ASCII dot and a
    // final label of two or more characters, so an abbreviation such as the
    // Russian "т.е." is not one.
    if (separators.includes(".") && [...(labels[labels.length - 1] ?? "")].length >= 2) return true;
  }
  return false;
}

/**
 * Whether a text names an address Studio cannot check: one of the forms above,
 * a punycode host, or an http(s) address that does not parse.
 */
export function namesUncheckableAddress(text: string): boolean {
  if (LOCALHOST_PATTERN.test(text) || IPV6_BRACKETED_PATTERN.test(text) ||
      IPV6_COMPRESSED_PATTERN.test(text) || IPV6_FULL_PATTERN.test(text) || namesUnicodeHost(text)) {
    return true;
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const authority = match[0].replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
    if (NON_ASCII_PATTERN.test(authority)) return true;
    try {
      if (new URL(match[0]).hostname.split(".").some((label) => label.startsWith("xn--"))) return true;
    } catch {
      return true;
    }
  }
  return /(^|[^a-z0-9-])xn--[a-z0-9-]+\./i.test(text);
}

// Rows that are not the conversation itself, as runtime-controller's
// NON_CONVERSATIONAL_AGENT_MESSAGE_TYPES (agent.rs) lists them, and the
// controller's own notices. Cards that ask the person for something
// (`*_request`) are left out too.
const NON_CONVERSATIONAL_MESSAGE_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "web_search",
  "file_change",
  "status",
  "token_usage",
  "reasoning",
  "learn_router",
  "todo_list",
  "browser_decision",
  "error",
  "runtime_alert",
  "run_cancellation",
]);

/** A message or reply the person could read in this conversation. */
function isConversationalRow(message: ChatMessage): boolean {
  if (!shouldDisplayChatMessage(message)) return false;
  const type = getMessageType(message);
  return !type || (!NON_CONVERSATIONAL_MESSAGE_TYPES.has(type) && !type.endsWith("_request"));
}

/**
 * Whether every address a card's task names is one the person could have
 * seen before Studio opens it by itself: in the person's own messages, or in
 * this conversation's replies from before the turn that sent the card, a
 * skill setup's included. Only rows the person could read count: never a
 * tool's output, a status line, reasoning, a request card or a hidden row.
 * An address Octo read on a page or in a tool's output during that turn, such
 * as a search result, is not seen, and neither is an address Studio cannot
 * check ({@link namesUncheckableAddress}), so its card stays a button and the
 * person sees the host first.
 */
export function browserAutoStartAddressesSeen(input: {
  task: string;
  messages: readonly ChatMessage[];
  cardIndex: number;
  currentUserId: string | null;
}): boolean {
  if (namesUncheckableAddress(input.task)) return false;
  const wanted = hostsNamedIn(input.task);
  if (wanted.size === 0) return true;
  const card = input.messages[input.cardIndex];
  const cardJobId = card ? browserRequestJobId(card) : null;
  const currentUserId = input.currentUserId?.trim() ?? "";
  const seen = new Set<string>();
  input.messages.forEach((message, index) => {
    if (!isConversationalRow(message)) return;
    const own = message.role === "user" && Boolean(currentUserId) && message.authorId === currentUserId &&
      !readBrowserRequestOf(message);
    const earlierReply = message.role === "assistant" && index < input.cardIndex &&
      (!cardJobId || browserRequestJobId(message) !== cardJobId);
    if (!own && !earlierReply) return;
    for (const host of hostsNamedIn(message.content)) seen.add(host);
  });
  return [...wanted].every((host) => seen.has(host));
}

// What this page remembers about automatic starts, in module memory only like
// the sent-prompt registry: a reload, another tab and another device start
// empty, and none of them can start a card they did not ask for anyway.
const claimedCards = new Set<string>();
const autoStartedAt = new Map<string, number>();
const declinedConversations = new Set<string>();
const MAX_REMEMBERED = 500;

/** One automatic start per conversation in this window. */
export const BROWSER_AUTO_START_CONVERSATION_WINDOW_MS = 10 * 60_000;

function remember<T>(collection: Set<T> | Map<T, unknown>) {
  while (collection.size > MAX_REMEMBERED) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) break;
    collection.delete(oldest);
  }
}

/** Claims a card once for this page, by its key; false when already claimed. */
export function claimBrowserAutoStart(cardKey: string): boolean {
  if (!cardKey || claimedCards.has(cardKey)) return false;
  claimedCards.add(cardKey);
  remember(claimedCards);
  return true;
}

export function isBrowserAutoStartClaimed(cardKey: string): boolean {
  return claimedCards.has(cardKey);
}

export function recordBrowserAutoStart(conversationKey: string, now = Date.now()): void {
  autoStartedAt.delete(conversationKey);
  autoStartedAt.set(conversationKey, now);
  remember(autoStartedAt);
}

/** True while this conversation's last automatic start is within the window. */
export function browserAutoStartedRecently(conversationKey: string, now = Date.now()): boolean {
  const at = autoStartedAt.get(conversationKey);
  return at !== undefined && now - at < BROWSER_AUTO_START_CONVERSATION_WINDOW_MS;
}

/** The person closed, paused or stopped the browser in this conversation. */
export function markBrowserAutoStartDeclined(conversationKey: string): void {
  if (!conversationKey) return;
  declinedConversations.add(conversationKey);
  remember(declinedConversations);
}

export function isBrowserAutoStartDeclined(conversationKey: string): boolean {
  return declinedConversations.has(conversationKey);
}

/** Empties what this page remembers, as a reload would. Tests only. */
export function forgetBrowserAutoStartsForTests(): void {
  claimedCards.clear();
  autoStartedAt.clear();
  declinedConversations.clear();
}
