import type {
  ControllerRuntimeStatusEntry,
  SharedBrowserHostPolicy,
} from "../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";
import type { ChatMessage } from "../types";
import {
  isManagedInstafyCloudProvider,
  listBrowserSessionCandidates,
  runtimeEntryIsLazyBrowserHost,
  runtimeEntryLooksLikeBrowserSession,
} from "./browserSessionRuntimeEnsure";
import { isBrowserNoticePrompt } from "./browserHandBack";
import { browserRequestJobId } from "./browserRequest";
import { getMessageType } from "./chatMessageMetadata";
import { shouldDisplayChatMessage } from "./chatMessagePresentation";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

/**
 * How Studio starts a request_browser card by itself (owner decisions, Oct 19
 * and wave 3: Octo opens Instafy's browser on its own, and never starts or
 * restarts a cloud machine to do it).
 *
 * - `personal`: the browser in this desktop app, for a person on their own AI.
 *   It asks for the person's chosen approval mode, as a press does.
 * - `attach`: Instafy's browser on the conversation's own machine, which
 *   starts it on demand (the controller reports `sharedBrowserHost` and the
 *   space is covered). Studio opens that exact machine's browser and never
 *   starts, stops or replaces the machine for it.
 * - `pending`: Studio needs a fresh reading of that browser first; it fetches
 *   one and decides again. Never claimed.
 * - `button`: the card stays a button, with the reason when there is one.
 *
 * A separate browser session machine, and the space's machine without
 * Instafy's browser on demand, still wait for a press. Studio cannot tell
 * whose running session it is (the controller does not record who started
 * one, so it may be a teammate's, with their pages and sign-ins), and opening
 * a new one starts a machine or switches the space's own machine to the
 * browser, which stops whatever it still runs, such as a preview, a dev
 * server or a terminal session, that Studio cannot see.
 */
export type BrowserAutoStartPlan =
  | { kind: "personal" }
  | { kind: "attach"; runtimeId: string }
  | { kind: "pending" }
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
  /** Another person or agent run controls it. */
  remoteController: boolean;
};

export const BROWSER_AUTO_START_COPY = {
  secondMachine: "This starts a second cloud machine for this space.",
  anotherMachine: "This starts another cloud machine for this space.",
  firstMachine: "This starts a cloud machine for this space.",
  restartsMachine: "This restarts this space's cloud machine as the browser, which stops anything still running on it.",
  inUse: "Instafy's browser is in use. Open it when it is free.",
  hostInUse: "Instafy's browser is in use. It opens here by itself once it is free.",
  otherSession: "A browser session is already running in this space. Open it when you are ready.",
  severalSessions: "Several browser sessions are running in this space. Open the one you want.",
  personalNeedsOwnAi: "The browser on this device needs your own AI connection.",
  unseenAddress: "Octo found this address itself. Check where it goes, then open it.",
  timedOut: "Instafy's browser did not start in time. Open it from the message to try again.",
  hostPoisoned: "Instafy's browser needs this space's machine to restart before it can open again.",
  presenceUnavailable: "Studio could not check who else is in Instafy's browser. Open it from the message to continue.",
  draftHeld: "Opens by itself once your draft is empty.",
} as const;

/** How old a reading of Instafy's browser on the space's machine may be for a decision. */
export const SHARED_BROWSER_HOST_SNAPSHOT_MAX_AGE_MS = 5_000;

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
  /**
   * Whether the controller opens Instafy's browser on this space's own
   * machine; absent or null from an older controller.
   */
  sharedBrowserHostPolicy?: SharedBrowserHostPolicy | null;
  /** The machine this conversation runs on. */
  conversationRuntimeId?: string | null;
  /** The last reading of that machine's browser; null when none (or a 404). */
  host?: SharedBrowserHostSnapshot | null;
  /** When that reading arrived; null before the first one. */
  hostReadAtMs?: number | null;
  nowMs?: number;
};

function isLiveHostedMachine(entry: ControllerRuntimeStatusEntry): boolean {
  return isManagedInstafyCloudProvider(entry.provider) &&
    entry.isLocal === false &&
    entry.isPrivateSelfHosted !== true &&
    !ENDED_RUNTIME_STATUSES.has(entry.status.trim().toLowerCase());
}

/**
 * A space machine that runs Instafy's browser on demand and is up: a managed
 * machine, not a person's own, that the controller reports as the browser's
 * host, with an origin and a status that takes work. Its last heartbeat does
 * not count: a reading of the browser says whether it answers, and the open
 * waits for it either way.
 */
function isLiveBrowserHostMachine(entry: ControllerRuntimeStatusEntry): boolean {
  const status = (entry.status ?? "").trim().toLowerCase();
  return runtimeEntryIsLazyBrowserHost(entry) &&
    isManagedInstafyCloudProvider(entry.provider) &&
    entry.isPrivateSelfHosted !== true &&
    (status === "" || status === "ready" || status === "running") &&
    Boolean(entry.origin?.originId?.trim());
}

/**
 * The conversation's own machine when the space is covered and that machine
 * is a live machine with an origin that starts Instafy's browser on demand;
 * null otherwise. A conversation that names no machine runs on the space's
 * machine, so it is the one live such machine when the space has exactly one.
 */
export function conversationBrowserHostId(
  input: Pick<BrowserAutoStartPlanInput, "sharedBrowserHostPolicy" | "conversationRuntimeId" | "runtimes">,
): string | null {
  if (input.sharedBrowserHostPolicy !== "covered" || !input.runtimes) return null;
  const runtimeId = input.conversationRuntimeId?.trim() ?? "";
  if (!runtimeId) {
    const hosts = input.runtimes.filter(isLiveBrowserHostMachine);
    return hosts.length === 1 ? hosts[0]!.runtimeId : null;
  }
  const machine = input.runtimes.find((entry) => entry.runtimeId === runtimeId);
  return machine && isLiveBrowserHostMachine(machine) ? machine.runtimeId : null;
}

/**
 * Whether Instafy's browser on the space's machine is someone else's right
 * now: someone else has it open or controls it, another person's agent run
 * works in it, or someone else is starting it.
 */
export function sharedBrowserHostHeldByOther(host: SharedBrowserHostSnapshot): boolean {
  return host.othersPresent ||
    host.controlledByOther ||
    (host.agentRunActive && !host.agentRunStartedByYou) ||
    (host.state === "starting" && !host.startedByYou);
}

/**
 * What Studio may do by itself for a card. The first matching row wins:
 *
 * | # | Condition                                                   | Result                          |
 * |---|-------------------------------------------------------------|---------------------------------|
 * | 1 | the browser on this device                                  | personal, or a button           |
 * | 2 | no host policy, or it is off                                | today's hosted buttons          |
 * | 3 | the conversation's machine is not a live host               | today's hosted buttons          |
 * | 4 | a separate browser session is running                       | button, no reason               |
 * | 5 | no reading of the host, or one older than five seconds     | pending                         |
 * | 6 | the host says it has no browser, or it is poisoned          | button                          |
 * | 7 | someone else has it, controls it, runs in it or starts it   | button (opens once free)        |
 * | 8 | otherwise, running or not (idle, failed, stopping, ready)   | attach                          |
 *
 * One rule the person can predict: on a space whose browser runs on its own
 * machine, a card opens by itself, and the open starts the browser when it
 * is not running, as a press does. On that machine a press is no approval, so
 * opening by itself skips no check. Only someone else holding the browser
 * (row 7) leaves the button, and the card opens once it is free.
 */
export function browserAutoStartPlan(input: BrowserAutoStartPlanInput): BrowserAutoStartPlan {
  if (input.transport === "personal") {
    if (!input.personalAvailable) return { kind: "button", reason: null };
    return input.personalOwnAi
      ? { kind: "personal" }
      : { kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi };
  }
  // Instafy's hosted browser.
  const projectId = input.projectId?.trim() ?? "";
  if (!projectId || !input.runtimes) return { kind: "button", reason: null };
  // Only separate browser session machines count as a running session; the
  // space's own machine with Instafy's browser on demand is not one.
  const sessions = listBrowserSessionCandidates([...input.runtimes]);
  const hostRuntimeId = conversationBrowserHostId(input);
  // Rows 2 and 3: a press decides, as before.
  if (!hostRuntimeId) return hostedButton(input.runtimes, sessions);
  // Row 4: a press opens the conversation's own machine, not the session,
  // so the card names neither.
  if (sessions.length > 0) return { kind: "button", reason: null };
  const now = input.nowMs ?? Date.now();
  const readAt = input.hostReadAtMs ?? null;
  if (readAt === null || now - readAt > SHARED_BROWSER_HOST_SNAPSHOT_MAX_AGE_MS) return { kind: "pending" };
  const host = input.host ?? null;
  // The machine answered that it has no such browser right now: a press
  // takes the usual path.
  if (!host) return { kind: "button", reason: null };
  // Only the machine's restart brings it back, and Studio never restarts one.
  if (host.state === "poisoned") return { kind: "button", reason: BROWSER_AUTO_START_COPY.hostPoisoned };
  // Held for now: decided again with the next reading, so the copy says it
  // opens by itself.
  if (sharedBrowserHostHeldByOther(host)) return { kind: "button", reason: BROWSER_AUTO_START_COPY.hostInUse };
  // Idle, stopped after a failure, stopping or in a state Studio does not
  // know: the open starts it, as a press does, and waits until it is ready.
  return { kind: "attach", runtimeId: hostRuntimeId };
}

/**
 * What a press on a card opens. In a covered space it is the conversation's
 * own machine by name, as Studio opening the card by itself does, so a press
 * never asks which machine; a browser this conversation already opened on a
 * machine stays the one it reopens. Otherwise it is the browser the
 * conversation used last, or none, and the view asks only when it cannot
 * tell which one is meant.
 */
export function browserPressRuntime(input: {
  transport: BrowserTransport;
  /** conversationBrowserHostId: the conversation's own machine, when covered. */
  hostRuntimeId: string | null;
  /** The machine this conversation's browser opened on, named exactly. */
  exactRuntimeId: string | null;
  /** The browser this conversation used last. */
  resolvedRuntimeId: string | null;
}): { resume: string } | { open: string | null } {
  if (input.transport !== "shared") return { open: null };
  if (input.hostRuntimeId && !input.exactRuntimeId) return { resume: input.hostRuntimeId };
  return { open: input.resolvedRuntimeId };
}

/** What a press would open, when Studio does not open Instafy's browser by itself. */
function hostedButton(
  runtimes: readonly ControllerRuntimeStatusEntry[],
  sessions: readonly unknown[],
): BrowserAutoStartPlan {
  // A browser session machine that is starting again, or whose heartbeat is
  // late, is still this space's browser session: a press opens that machine
  // again (the controller restarts one that stopped answering) and never
  // starts a second one, so the card says so, as it does while it answers.
  const sessionCount = Math.max(
    sessions.length,
    runtimes.filter((entry) => isLiveHostedMachine(entry) && runtimeEntryLooksLikeBrowserSession(entry)).length,
  );
  if (sessionCount > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.severalSessions };
  // Whoever started it: the controller does not record that.
  if (sessionCount === 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession };
  // Opening a browser here would start a machine, or restart this space's
  // own one.
  const machines = runtimes.filter(isLiveHostedMachine);
  if (machines.length === 0) return { kind: "button", reason: BROWSER_AUTO_START_COPY.firstMachine };
  // Instafy's browser on the space's own machine opens in place; a press
  // neither restarts nor adds a machine.
  if (machines.some(runtimeEntryIsLazyBrowserHost)) return { kind: "button", reason: null };
  if (machines.length > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.anotherMachine };
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
 * Whether a browser is busy elsewhere, so a card waits for the person: an
 * agent run or another person controls Instafy's browser, or the browser on
 * this device is in a manual step. The pending handoff outlives the manual
 * step's status request, which Desktop clears on a sign-in redirect.
 */
export function browserAutoStartHeldByOther(input: {
  browserRunActive: boolean;
  remoteController: boolean;
  humanInputRequest: boolean;
  pendingHandoff: boolean;
}): boolean {
  return input.browserRunActive || input.remoteController || input.humanInputRequest || input.pendingHandoff;
}

/**
 * Whether the person's draft leaves a card to them for now: Studio does not
 * open the browser over a message the person is still writing. The layout
 * never holds a card (owner decision, Oct 19: "Always, no prompt"): in a
 * narrow pane or with side-by-side view off, the browser takes the view, as a
 * press does, and the chat stays one tab away.
 */
export function browserAutoStartHeldByDraft(input: { draft: string }): boolean {
  return input.draft.trim().length > 0;
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
      !isBrowserNoticePrompt(message);
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

/**
 * One automatic start that opens the browser per conversation in this window.
 * A card that continues in Instafy's browser while it is already open on the
 * conversation's machine starts nothing, so this window does not apply to it.
 */
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
