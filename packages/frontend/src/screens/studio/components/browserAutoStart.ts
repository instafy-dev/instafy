import type { ControllerRuntimeStatusEntry } from "../../../services/runtimeController";
import type { ChatMessage } from "../types";
import {
  isManagedInstafyCloudProvider,
  listBrowserRuntimeCandidates,
} from "./browserSessionRuntimeEnsure";
import { browserRequestJobId, readBrowserRequestOf } from "./browserRequest";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

/**
 * How Studio starts a request_browser card by itself (owner decision, Oct 19:
 * Octo opens Instafy's browser on its own, and never starts or restarts a
 * cloud machine to do it).
 *
 * - `reuse`: the one browser session running in this space is the one this
 *   person opened in this conversation.
 * - `personal`: the browser in this desktop app, for a person on their own AI.
 *   It asks for the person's chosen approval mode, as a press does.
 * - `button`: the card stays a button, with the reason when there is one.
 *
 * Studio never switches the space's own machine to the browser by itself:
 * that stops whatever the machine still runs, such as a preview, a dev server
 * or a terminal session, and Studio cannot see those.
 */
export type BrowserAutoStartPlan =
  | { kind: "reuse"; runtimeId: string }
  | { kind: "personal" }
  | { kind: "button"; reason: string | null };

/**
 * Who else is in Instafy's browser, from its collaboration roster:
 * `unknown` until the roster connects, `unavailable` when it cannot.
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
  presenceUnknown: "Studio could not check who else is in Instafy's browser. Open it when you are ready.",
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
  /**
   * The browser session this person opened in this conversation, from their
   * own per-conversation browser state, or null. The controller does not
   * record who started a session, so this is how Studio tells the person's
   * own session from one a teammate started.
   */
  ownSessionRuntimeId: string | null;
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
  const projectId = input.projectId?.trim() ?? "";
  if (!projectId || !input.runtimes) return { kind: "button", reason: null };
  const sessions = listBrowserRuntimeCandidates([...input.runtimes]);
  if (sessions.length > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.severalSessions };
  if (sessions.length === 1) {
    // Never another member's browser state: only the session this person
    // opened here, and the hook checks again that nobody else is in it.
    const own = input.ownSessionRuntimeId?.trim() ?? "";
    return own && sessions[0]!.runtimeId === own
      ? { kind: "reuse", runtimeId: own }
      : { kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession };
  }
  // Opening a browser here would start a machine, or restart this space's
  // own one: the person decides.
  const machines = input.runtimes.filter(isLiveHostedMachine);
  if (machines.length === 0) return { kind: "button", reason: BROWSER_AUTO_START_COPY.firstMachine };
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

/**
 * Whether every address a card's task names is one the person could have
 * seen before Studio opens it by itself: in a skill setup (where an address
 * comes only from the skill's declaration), in the person's own messages, or
 * in this conversation's assistant text from before the turn that sent the
 * card. An address Octo read on a page or in a tool's output during that
 * turn, such as a search result, is not, so its card stays a button and the
 * person sees the host first.
 */
export function browserAutoStartAddressesSeen(input: {
  task: string;
  messages: readonly ChatMessage[];
  cardIndex: number;
  currentUserId: string | null;
  skillSetup: boolean;
}): boolean {
  const wanted = hostsNamedIn(input.task);
  if (wanted.size === 0 || input.skillSetup) return true;
  const card = input.messages[input.cardIndex];
  const cardJobId = card ? browserRequestJobId(card) : null;
  const currentUserId = input.currentUserId?.trim() ?? "";
  const seen = new Set<string>();
  input.messages.forEach((message, index) => {
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
